/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import { useServerFn } from '@tanstack/react-start'
import { useQuery } from '@tanstack/react-query'
import {
	pickAvailableHandleSuggestion,
	verifiedHandleSuggestionCacheMs,
	verifiedHandleSuggestionDebounceMs,
	waitForDebounce,
	type PickedSuggestion,
} from '#client/verified-handle-suggestion.ts'
import { checkWebsiteUsernameAvailability } from '#start/server/auth-mutations'
import { colors, radius, typography } from '#universal/styles/tokens.ts'

/**
 * The derived suggestion for `candidate`, or null until the availability
 * check confirms a free handle (the candidate or its first free variant).
 */
export function useVerifiedHandleSuggestion(candidate: string | null) {
	const checkAvailability = useServerFn(checkWebsiteUsernameAvailability)
	const query = useQuery({
		queryKey: ['verified-handle-suggestion', candidate],
		queryFn: async ({ signal }): Promise<PickedSuggestion> => {
			const username = candidate ?? ''
			await waitForDebounce(verifiedHandleSuggestionDebounceMs, signal)
			try {
				return pickAvailableHandleSuggestion(
					username,
					await checkAvailability({ signal, data: { username } }),
				)
			} catch (error) {
				if (signal.aborted) throw error
				return { suggestion: null, verified: false }
			}
		},
		enabled: Boolean(candidate),
		staleTime: (query) =>
			query.state.data?.verified ? verifiedHandleSuggestionCacheMs : 0,
		gcTime: verifiedHandleSuggestionCacheMs,
		retry: false,
		refetchOnWindowFocus: false,
	})
	return candidate && !query.isFetching
		? (query.data?.suggestion ?? null)
		: null
}

/**
 * "Try <suggestion>." where the suggestion is a link-styled button that
 * applies it. Callers pass only verified suggestions and move focus back to
 * their field in `onApply`.
 */
export function HandleSuggestion(props: {
	suggestion: string | null
	onApply: (suggestion: string) => void
	disabled?: boolean
}) {
	const { suggestion } = props
	if (!suggestion) return null
	return (
		<>
			{' '}
			Try{' '}
			<button
				type="button"
				data-testid="handle-suggestion"
				aria-label={`Use ${suggestion}`}
				disabled={props.disabled}
				onClick={() => props.onApply(suggestion)}
				css={suggestionLinkCss}
			>
				{suggestion}
			</button>
			.
		</>
	)
}

const suggestionLinkCss: CSSObject = {
	appearance: 'none',
	display: 'inline',
	margin: 0,
	padding: 0,
	border: 'none',
	background: 'none',
	font: 'inherit',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	textDecoration: 'underline',
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	borderRadius: radius.sm,
	cursor: 'pointer',
	overflowWrap: 'anywhere',
	'&:hover': { color: colors.text },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'&:disabled': {
		opacity: 0.6,
		cursor: 'not-allowed',
	},
}
