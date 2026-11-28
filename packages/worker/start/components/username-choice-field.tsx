/** @jsxImportSource @emotion/react */
import { useId, useRef, type ChangeEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsernameAvailabilityView as AvailabilityView } from '#client/routes/username-availability-state.ts'
import { useServerFn } from '@tanstack/react-start'
import {
	handleFormatHint,
	getHandleFormatProblem,
} from '@kody-internal/shared/handle-rules.ts'
import {
	handleEmailLocalPreview,
	handlePackageAppUrlPreview,
	handleUrlPreview,
	signupUsernamePermanentNote,
} from '@kody-internal/shared/handle-permanence.ts'
import { permanentHandleInputProps } from '#client/handle-field.ts'
import { checkWebsiteUsernameAvailability } from '#start/server/auth-mutations'
import { waitForDebounce } from '#client/verified-handle-suggestion.ts'
import {
	colors,
	radius,
	shadows,
	typography,
} from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	hoverMq,
	getSquircleCss,
} from '#universal/styles/style-primitives.ts'
import type { CSSObject } from '@emotion/react'
import { renderIcon } from './icon.tsx'
import { Input } from './input.tsx'
import {
	HandleSuggestion,
	useVerifiedHandleSuggestion,
} from './handle-suggestion.tsx'
export type UsernameAvailabilityView = AvailabilityView

export type UsernameChoiceSeeds = {
	email?: string | null
	providerUsername?: string | null
	displayName?: string | null
}

const availabilityDebounceMs = 300
const visibleSuggestionLimit = 2

const unknownAvailabilityReason =
	"Couldn't check availability. We'll verify on submit."

function unknownAvailability(
	username: string,
	reason = unknownAvailabilityReason,
): UsernameAvailabilityView {
	return { status: 'unknown', username, reason, suggestions: [] }
}

function availabilityFromResponse(
	trimmed: string,
	result: unknown,
): UsernameAvailabilityView {
	const response =
		result && typeof result === 'object'
			? (result as Record<string, unknown>)
			: null
	if (!response || response.ok !== true)
		return unknownAvailability(
			trimmed.toLowerCase(),
			typeof response?.error === 'string'
				? response.error
				: unknownAvailabilityReason,
		)
	const status = response.status
	const username =
		typeof response.username === 'string'
			? response.username
			: trimmed.toLowerCase()
	if (
		status !== 'available' &&
		status !== 'taken' &&
		status !== 'reserved' &&
		status !== 'invalid'
	)
		return unknownAvailability(username)
	return {
		status,
		username,
		reason:
			typeof response.reason === 'string' || response.reason === null
				? response.reason
				: null,
		suggestions: Array.isArray(response.suggestions)
			? response.suggestions.filter(
					(value): value is string => typeof value === 'string',
				)
			: [],
	}
}

/**
 * Live availability for a username draft: idle when empty, invalid on a
 * format problem, otherwise a debounced server check. The check is keyed on
 * the username alone: seeds only shape suggestions for a taken name, so
 * editing them (like the email beside the field) never starts a new check.
 */
export function useUsernameAvailability(
	value: string,
	seeds?: UsernameChoiceSeeds,
): UsernameAvailabilityView {
	const checkAvailability = useServerFn(checkWebsiteUsernameAvailability)
	const trimmed = value.trim()
	const formatError = trimmed ? getHandleFormatProblem(trimmed)?.message : null
	const query = useQuery({
		queryKey: ['username-availability', trimmed],
		queryFn: async ({ signal }) => {
			const data = {
				username: trimmed,
				email: seeds?.email ?? null,
				providerUsername: seeds?.providerUsername ?? null,
				displayName: seeds?.displayName ?? null,
			}
			await waitForDebounce(availabilityDebounceMs, signal)
			try {
				return availabilityFromResponse(
					trimmed,
					await checkAvailability({ signal, data }),
				)
			} catch (error) {
				if (signal.aborted) throw error
				return unknownAvailability(trimmed.toLowerCase())
			}
		},
		enabled: Boolean(trimmed) && !formatError,
		staleTime: 0,
		gcTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
	})
	if (!trimmed) return { status: 'idle' }
	if (formatError)
		return {
			status: 'invalid',
			username: trimmed.toLowerCase(),
			reason: formatError,
			suggestions: [],
		}
	return query.data && !query.isFetching ? query.data : { status: 'checking' }
}

export function UsernameChoiceField(props: {
	value: string
	onChange: (value: string) => void
	seeds?: UsernameChoiceSeeds
	disabled?: boolean
	autoFocus?: boolean
	inputId?: string
	describedBy?: string
	invalid?: boolean
	statusId?: string
	/** When true, announce the confirm-step permanence restatement under the field. */
	confirming?: boolean
}) {
	const generatedId = useId()
	const inputId = props.inputId ?? `${generatedId}-username`
	const idPrefix = props.inputId ?? generatedId
	const tipId = `${idPrefix}-username-tip`
	const tipAnchor = `--${idPrefix.replace(/:/g, '')}-username-tip`
	const availabilityId = `${idPrefix}-username-availability`
	const availability = useUsernameAvailability(props.value, props.seeds)

	const inputRef = useRef<HTMLInputElement>(null)
	const formatProblem = props.value.trim()
		? getHandleFormatProblem(props.value.trim())
		: null
	const formatSuggestion = useVerifiedHandleSuggestion(
		formatProblem?.suggestion ?? null,
	)
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
		inputRef.current?.focus()
		props.onChange(suggestion)
	}

	return (
		<div css={fieldCss}>
			<div css={labelRowCss}>
				<label htmlFor={inputId} css={fieldLabelCss}>
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
			<Input
				ref={inputRef}
				id={inputId}
				type="text"
				name="username"
				required
				autoFocus={props.autoFocus}
				autoComplete="username"
				placeholder="yourname"
				disabled={props.disabled}
				value={props.value}
				aria-invalid={props.invalid ? true : undefined}
				aria-describedby={describedBy}
				{...permanentHandleInputProps({ caseInsensitivePattern: true })}
				onChange={(event: ChangeEvent<HTMLInputElement>) =>
					props.onChange(event.currentTarget.value)
				}
				background="canvas"
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
					{formatProblem && availability.status === 'invalid' ? (
						<HandleSuggestion
							suggestion={formatSuggestion}
							onApply={applySuggestion}
							disabled={props.disabled}
						/>
					) : null}
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
			<p
				role="status"
				css={confirmCss}
				data-testid="username-permanence-confirm"
			>
				{props.confirming ? (
					<>
						You're choosing <strong>{preview}</strong>.{' '}
						{signupUsernamePermanentNote}
					</>
				) : null}
			</p>
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
	...getSquircleCss('xs'),
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

// The live region stays mounted so screen readers announce the confirm
// line; while empty it leaves the grid so it adds no gap.
const confirmCss: CSSObject = {
	margin: 0,
	'&:empty': { position: 'absolute' },
	fontSize: typography.fontSize.sm,
	lineHeight: 1.4,
	color: colors.textMuted,
}
