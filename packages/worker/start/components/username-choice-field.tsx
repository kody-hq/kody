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
	signupUsernameSurfacesPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import { permanentHandleInputProps } from '#client/handle-field.ts'
import { checkWebsiteUsernameAvailability } from '#start/server/auth-mutations'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	authFieldCss,
	authFieldLabelCss,
	getAuthInputCss,
} from '#universal/styles/style-primitives.ts'
import { type CSSObject } from '@emotion/react'
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'

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
	const noteId = `${generatedId}-username-note`
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
									: 'Unable to check username availability. You can still continue; we will verify on submit.',
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
							reason:
								'Unable to check username availability. You can still continue; we will verify on submit.',
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
						reason:
							'Unable to check username availability. You can still continue; we will verify on submit.',
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
	const describedBy = [
		noteId,
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
			<label htmlFor={inputId} css={authFieldLabelCss}>
				Username
			</label>
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
			<p id={noteId} css={helperCss}>
				{handleFormatHint} {signupUsernamePermanentNote}{' '}
				{signupUsernameSurfacesPreview(preview)} Your profile URL will be{' '}
				<strong>{handleUrlPreview(preview)}</strong>, apps at{' '}
				<strong>{handlePackageAppUrlPreview(preview)}</strong>, mail from{' '}
				<strong>{handleEmailLocalPreview(preview)}</strong>.
			</p>
			<p
				id={availabilityId}
				role="status"
				aria-live="polite"
				css={availabilityCss}
				data-status={availability.status}
			>
				{availabilityMessage(availability)}
			</p>
			{availability.status === 'taken' ||
			availability.status === 'reserved' ||
			(availability.status === 'invalid' &&
				availability.suggestions.length > 0) ? (
				<ul css={suggestionsCss} aria-label="Available username suggestions">
					{availability.suggestions.map((suggestion) => (
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
			{props.confirming ? (
				<p css={confirmCss} data-testid="username-permanence-confirm">
					You're choosing <strong>{preview}</strong>.{' '}
					{signupUsernamePermanentNote} {signupUsernameSurfacesPreview(preview)}
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
			return 'Checking availability…'
		case 'available':
			return `${view.username} is available.`
		case 'taken':
		case 'reserved':
		case 'invalid':
			return view.reason ?? 'That username cannot be used.'
		case 'unknown':
			return (
				view.reason ??
				'Unable to check username availability. You can still continue; we will verify on submit.'
			)
		default: {
			const exhaustive: never = view
			return exhaustive
		}
	}
}

const authInputCss = getAuthInputCss({ background: 'canvas' })

const helperCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	lineHeight: 1.45,
}

const availabilityCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.4,
	color: colors.textMuted,
	minHeight: '1.2em',
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
	gap: '0.45rem',
}

const suggestionButtonCss: CSSObject = {
	appearance: 'none',
	border: `1px solid ${colors.border}`,
	background: colors.background,
	color: colors.text,
	borderRadius: '0.45rem',
	padding: '0.35rem 0.65rem',
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
	padding: '0.75rem 0.85rem',
	borderRadius: '0.55rem',
	border: `1px solid ${colors.border}`,
	background: colors.background,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.45,
	color: colors.text,
}
