/** @jsxImportSource @emotion/react */
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { useCallback, useRef, useEffect } from 'react'
import { useActor } from '@xstate/react'
import {
	clipboardFeedbackState,
	type ClipboardFeedbackState,
	type CopyState,
} from '#client/routes/clipboard-feedback-state.ts'
import type { CSSObject } from '@emotion/react'
import { writeClipboardText } from '#client/clipboard.ts'
import { renderHighlightedCode } from './syntax-highlight.tsx'
import {
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'
import { renderIcon, type IconName } from './icon.tsx'
import {
	hoverMq,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
export type CopyCodeBlockProps = {
	code: string
	lang?: string | null
	copy?: boolean
	highlighted?: HighlightedCode
}

/**
 * A highlighted `<pre>` code block with an optional copy button, for
 * first-party markdown surfaces (guides) whose snippets exist to be pasted
 * into an agent or terminal. Only the button is interactive. Pass
 * `copy={false}` on transcript-style pages that should not invite a paste.
 */
export function CopyCodeBlock(props: CopyCodeBlockProps) {
	const [copyFlowSnapshot, , copyFlowActor] = useActor(clipboardFeedbackState)
	const copyFlow = uiState<ClipboardFeedbackState>(copyFlowSnapshot)
	const transitionCopy = useCallback(
		(event: Parameters<typeof copyFlowActor.send>[0]) =>
			sendUiEvent(copyFlowActor, event),
		[copyFlowActor],
	)

	const copyState = copyFlow.status === 'copying' ? 'idle' : copyFlow.status
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			if (resetTimer.current) clearTimeout(resetTimer.current)
		}
	}, [])
	async function copy() {
		if (
			!transitionCopy({
				type: 'COPY',
				data: uiContext({ status: 'copying' }).data,
			} as Parameters<typeof copyFlowActor.send>[0])
		)
			return
		if (resetTimer.current) clearTimeout(resetTimer.current)
		let next: CopyState
		try {
			await writeClipboardText(props.code)
			next = 'copied'
		} catch {
			next = 'error'
		}
		if (!mounted.current) return
		transitionCopy({
			type: next === 'copied' ? 'RESPONSE_OK' : 'RESPONSE_ERROR',
			data: {},
		} as Parameters<typeof copyFlowActor.send>[0])
		if (resetTimer.current) clearTimeout(resetTimer.current)
		resetTimer.current = setTimeout(
			() =>
				transitionCopy({
					type: 'RESET',
					data: uiContext({ status: 'idle' }).data,
				} as Parameters<typeof copyFlowActor.send>[0]),
			2000,
		)
	}
	const showCopy = props.copy !== false
	return (
		<div data-copy-code={showCopy ? '' : undefined} css={wrapperCss}>
			{renderHighlightedCode(
				props.highlighted ?? plainHighlightedCode(props.code, props.lang),
			)}
			{showCopy ? (
				<button
					aria-busy={copyFlow.status === 'copying'}
					disabled={copyFlow.status === 'copying'}
					type="button"
					data-copy-state={copyState}
					aria-label="Copy code to clipboard"
					css={copyButtonCss}
					onClick={() => void copy()}
				>
					{renderIcon(copyButtonIcon(copyState), { size: '1rem' })}
				</button>
			) : null}
			{showCopy ? (
				<span role="status" css={visuallyHiddenCss}>
					{copyStatusText(copyState)}
				</span>
			) : null}
		</div>
	)
}

function copyButtonIcon(state: CopyState): IconName {
	switch (state) {
		case 'idle':
			return 'copy'
		case 'copied':
			return 'check'
		case 'error':
			return 'warning-triangle'
		default: {
			const _exhaustive: never = state
			return _exhaustive
		}
	}
}

function copyStatusText(state: CopyState) {
	switch (state) {
		case 'idle':
			return ''
		case 'copied':
			return 'Copied'
		case 'error':
			return 'Copy failed'
		default: {
			const _exhaustive: never = state
			return _exhaustive
		}
	}
}

const wrapperCss = {
	position: 'relative' as const,
	minWidth: 0,
	maxWidth: '100%',
	'& pre': {
		margin: 0,
		padding: `${spacing.sm} ${spacing.md}`,
		overflowX: 'auto' as const,
		maxWidth: '100%',
	},
	// The icon sits in the corner of the card. Scroll the snippet in a box
	// that stops before that column so a long line never runs underneath it.
	'&[data-copy-code] pre': {
		paddingInlineEnd: '0.45rem',
		overflowX: 'hidden' as const,
	},
	'&[data-copy-code] pre code': {
		display: 'block',
		minWidth: 0,
		overflowX: 'auto' as const,
		marginInlineEnd: '2.35rem',
	},
} satisfies CSSObject

// Always visible (quiet at rest): hover-reveal would hide the affordance on
// touch devices, and guide snippets exist to be copied.
const copyButtonCss = {
	position: 'absolute' as const,
	zIndex: 1,
	top: '0.45rem',
	right: '0.45rem',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2rem',
	height: '2rem',
	padding: 0,
	flex: 'none',
	appearance: 'none' as const,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.textMuted,
	lineHeight: 0,
	cursor: 'pointer',
	opacity: 0.92,
	transition: 'opacity 120ms ease, color 120ms ease',
	[hoverMq]: {
		'&:hover': {
			opacity: 1,
			color: colors.text,
		},
	},
	'&:focus-visible': {
		opacity: 1,
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'&[data-copy-state="copied"]': {
		opacity: 1,
		color: colors.primaryText,
	},
	'&[data-copy-state="error"]': {
		opacity: 1,
		color: colors.danger,
	},
} satisfies CSSObject
