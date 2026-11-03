/** @jsxImportSource @emotion/react */
import { useServerFn } from '@tanstack/react-start'
import {
	handleFormatHint,
	getHandleFormatError,
} from '@kody-internal/shared/handle-rules.ts'
import {
	handleEmailLocalPreview,
	handlePackageAppUrlPreview,
	handleUrlPreview,
	signupUsernamePermanentNote,
} from '@kody-internal/shared/handle-permanence.ts'
import { permanentHandleInputProps } from '#client/handle-field.ts'
import { checkWebsiteUsernameAvailability } from '#start/server/auth-mutations'
import {
	colors,
	radius,
	shadows,
	typography,
} from '#universal/styles/tokens.ts'
import {
	authFieldCss,
	authFieldLabelCss,
	getAuthInputCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import type { CSSObject } from '@emotion/react'
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { renderIcon } from './icon.tsx'

export type UsernameAvailabilityView =
	| { status: 'idle' }
	| { status: 'checking' }
	| {
			status: 'available' | 'taken' | 'reserved' | 'invalid' | 'unknown'
			username: string
			reason: string | null
			suggestions: Array<string>
	  }

export type UsernameChoiceSeeds = {
	email?: string | null
	providerUsername?: string | null
	displayName?: string | null
}

const availabilityDebounceMs = 300
const visibleSuggestionLimit = 2

export function UsernameChoiceField(props: {
	value: string
	onChange: (value: string) => void
	onAvailabilityChange?: (view: UsernameAvailabilityView) => void
	seeds?: UsernameChoiceSeeds
	disabled?: boolean
	autoFocus?: boolean
	inputId?: string
	describedBy?: string
	invalid?: boolean
	statusId?: string
	/** When true, show the confirm-step permanence restatement under the field. */
	confirming?: boolean
}) {
	const checkAvailability = useServerFn(checkWebsiteUsernameAvailability)
	const generatedId = useId()
	const inputId = props.inputId ?? `${generatedId}-username`
	const tipId = `${generatedId}-username-tip`
	const tipAnchor = `--${generatedId.replace(/:/g, '')}-username-tip`
	const availabilityId = `${generatedId}-username-availability`
	const [availability, setAvailability] = useState<UsernameAvailabilityView>({
		status: 'idle',
	})
	const requestSeq = useRef(0)
	const lifecycle = useRef<AbortController | null>(null)

	useEffect(() => {
		const controller = new AbortController()
		lifecycle.current = controller
		return () => controller.abort()
	}, [])

	const onAvailabilityChange = props.onAvailabilityChange
	useEffect(() => {
		onAvailabilityChange?.(availability)
	}, [availability, onAvailabilityChange])

	useEffect(() => {
		const trimmed = props.value.trim()
		if (!trimmed) {
			setAvailability({ status: 'idle' })
			return
		}

		const formatError = getHandleFormatError(trimmed)
		if (formatError) {
			setAvailability({
				status: 'invalid',
				username: trimmed.toLowerCase(),
				reason: formatError,
				suggestions: [],
			})
			return
		}

		const seq = ++requestSeq.current
		setAvailability({ status: 'checking' })
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const result = await checkAvailability({
						signal: lifecycle.current?.signal,
						data: {
							username: trimmed,
							email: props.seeds?.email ?? null,
							providerUsername: props.seeds?.providerUsername ?? null,
							displayName: props.seeds?.displayName ?? null,
						},
					})
					if (lifecycle.current?.signal.aborted) return
					if (seq !== requestSeq.current) return
					if (!result || result.ok !== true) {
						setAvailability({
							status: 'unknown',
							username: trimmed.toLowerCase(),
							reason:
								typeof result?.error === 'string'
									? result.error
									: "Couldn't check availability. We'll verify on submit.",
							suggestions: [],
						})
						return
					}
					const status = result.status
					const username =
						typeof result.username === 'string'
							? result.username
							: trimmed.toLowerCase()
					if (
						status !== 'available' &&
						status !== 'taken' &&
						status !== 'reserved' &&
						status !== 'invalid'
					) {
						setAvailability({
							status: 'unknown',
							username,
							reason: "Couldn't check availability. We'll verify on submit.",
							suggestions: [],
						})
						return
					}
					setAvailability({
						status,
						username,
						reason:
							typeof result.reason === 'string' || result.reason === null
								? result.reason
								: null,
						suggestions: Array.isArray(result.suggestions)
							? result.suggestions.filter(
									(value): value is string => typeof value === 'string',
								)
							: [],
					})
				} catch {
					if (lifecycle.current?.signal.aborted) return
					if (seq !== requestSeq.current) return
					setAvailability({
						status: 'unknown',
						username: trimmed.toLowerCase(),
						reason: "Couldn't check availability. We'll verify on submit.",
						suggestions: [],
					})
				}
			})()
		}, availabilityDebounceMs)

		return () => clearTimeout(timer)
	}, [
		props.value,
		props.seeds?.email,
		props.seeds?.providerUsername,
		props.seeds?.displayName,
		checkAvailability,
	])

	const preview = props.value.trim().toLowerCase() || 'your-username'
	const suggestions =
		availability.status === 'taken' ||
		availability.status === 'reserved' ||
		availability.status === 'invalid'
			? availability.suggestions.slice(0, visibleSuggestionLimit)
			: []
	const describedBy = [
		availabilityId,
		props.describedBy,
		props.invalid && props.statusId ? props.statusId : null,
	]
		.filter(Boolean)
		.join(' ')

	function applySuggestion(suggestion: string) {
		props.onChange(suggestion)
	}

	return (
		<div css={authFieldCss}>
			<div css={labelRowCss}>
				<label htmlFor={inputId} css={authFieldLabelCss}>
					Username
				</label>
				<button
					type="button"
					popoverTarget={tipId}
					aria-label="About this handle"
					disabled={props.disabled}
					css={{ ...tipButtonCss, anchorName: tipAnchor }}
				>
					{renderIcon('information', { size: '1.05rem' })}
				</button>
				<div
					id={tipId}
					popover="auto"
					role="dialog"
					aria-label="About this handle"
					css={{ ...tipPanelCss, positionAnchor: tipAnchor }}
				>
					<p css={tipBodyCss}>{signupUsernamePermanentNote}</p>
					<p css={tipBodyCss}>{handleFormatHint}</p>
					<p css={tipBodyCss}>
						Used for package names,{' '}
						<strong>{handlePackageAppUrlPreview(preview)}</strong>,{' '}
						<strong>{handleUrlPreview(preview)}</strong>, and{' '}
						<strong>{handleEmailLocalPreview(preview)}</strong>.
					</p>
				</div>
			</div>
			<input
				id={inputId}
				type="text"
				name="username"
				required
				autoFocus={props.autoFocus}
				autoComplete="username"
				placeholder="kent"
				disabled={props.disabled}
				value={props.value}
				data-field-ring
				aria-invalid={props.invalid ? true : undefined}
				aria-describedby={describedBy}
				{...permanentHandleInputProps({ caseInsensitivePattern: true })}
				onChange={(event: ChangeEvent<HTMLInputElement>) =>
					props.onChange(event.currentTarget.value)
				}
				css={authInputCss}
			/>
			<div css={statusRowCss}>
				<p
					id={availabilityId}
					role="status"
					aria-live="polite"
					css={availabilityCss}
					data-status={availability.status}
				>
					{availabilityMessage(availability)}
				</p>
				{suggestions.length > 0 ? (
					<ul css={suggestionsCss} aria-label="Available username suggestions">
						{suggestions.map((suggestion) => (
							<li key={suggestion}>
								<button
									type="button"
									disabled={props.disabled}
									onClick={() => applySuggestion(suggestion)}
									css={suggestionButtonCss}
								>
									{suggestion}
								</button>
							</li>
						))}
					</ul>
				) : null}
			</div>
			{props.confirming ? (
				<p css={confirmCss} data-testid="username-permanence-confirm">
					You're choosing <strong>{preview}</strong>.{' '}
					{signupUsernamePermanentNote}
				</p>
			) : null}
		</div>
	)
}

function availabilityMessage(view: UsernameAvailabilityView) {
	switch (view.status) {
		case 'idle':
			return ''
		case 'checking':
			return 'Checking…'
		case 'available':
			return `${view.username} is available.`
		case 'taken':
		case 'reserved':
		case 'invalid':
			return view.reason ?? 'That username cannot be used.'
		case 'unknown':
			return (
				view.reason ?? "Couldn't check availability. We'll verify on submit."
			)
		default: {
			const exhaustive: never = view
			return exhaustive
		}
	}
}

const authInputCss = getAuthInputCss({ background: 'canvas' })

const labelRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.35rem',
	'& > label': {
		margin: 0,
	},
}

const tipButtonCss: CSSObject = {
	display: 'inline-flex',
	flex: 'none',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.55rem',
	height: '1.55rem',
	padding: 0,
	border: 'none',
	borderRadius: radius.full,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			backgroundColor: colors.primarySoft,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'&:disabled': {
		opacity: 0.6,
		cursor: 'not-allowed',
	},
}

const tipPanelCss: CSSObject = {
	positionArea: 'bottom span-right',
	positionTryFallbacks: 'flip-block, flip-inline',
	inset: 'auto',
	width: 'min(22rem, calc(100vw - 2.5rem))',
	margin: '0.35rem',
	padding: '0.85rem 1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	boxSizing: 'border-box' as const,
	gap: '0.55rem',
	'&:popover-open': {
		display: 'grid',
	},
}

const tipBodyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.45,
	textWrap: 'pretty' as const,
}

const statusRowCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: '0.4rem 0.65rem',
	minHeight: '1.7rem',
}

const availabilityCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.35,
	color: colors.textMuted,
	flex: '1 1 8rem',
	minWidth: 0,
	'&[data-status="available"]': { color: colors.primaryText },
	'&[data-status="taken"], &[data-status="reserved"], &[data-status="invalid"]':
		{
			color: colors.error,
		},
	'&[data-status="unknown"]': {
		color: colors.textMuted,
	},
}

const suggestionsCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap',
	gap: '0.35rem',
	flex: '0 1 auto',
}

const suggestionButtonCss: CSSObject = {
	appearance: 'none',
	border: `1px solid ${colors.border}`,
	background: colors.background,
	color: colors.text,
	borderRadius: '0.45rem',
	padding: '0.2rem 0.55rem',
	fontSize: typography.fontSize.sm,
	cursor: 'pointer',
	'&:hover': {
		borderColor: colors.primary,
		color: colors.primaryText,
	},
	'&:disabled': {
		opacity: 0.6,
		cursor: 'not-allowed',
	},
}

const confirmCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.4,
	color: colors.textMuted,
}
