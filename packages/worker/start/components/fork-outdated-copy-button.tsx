/** @jsxImportSource @emotion/react */
import { mergeCss } from './merge-css.ts'
import { SiteLink } from './site-link.tsx'
/** @jsxRuntime automatic */
import { type CSSObject } from '@emotion/react'
import { useState, useRef, useEffect } from 'react'
import { writeClipboardText } from '#client/clipboard.ts'
import { communityStatusPillBoxCss } from '#universal/community-status-pill.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
export const FORK_OUTDATED_COPY_TOOLTIP = 'Click to copy an update prompt'
export const FORKED_COPY_TOOLTIP =
	'Click to copy a prompt to finish adapting this fork'

export const FORK_AHEAD_TOOLTIP =
	'Review the listing snapshot this fork is ahead of'

type CopyPromptPillInput = {
	label: string
	prompt: string
	testId: string
	tooltip: string
	tone: 'badge' | 'outdated'
	href?: string | null
}

type ForkOutdatedCopyButtonProps = {
	prompt: string
	testId: string
	href?: string | null
}

type ForkAheadLinkProps = {
	href: string
	testId: string
}

/**
 * Static HTML copy pill. Frames render it without hydration; the app copies
 * `data-copy-text` on click and swaps the tooltip.
 */
export function renderCopyPromptPill(input: CopyPromptPillInput) {
	return <CopyPromptPill {...input} />
}
function CopyPromptPill(input: CopyPromptPillInput) {
	const [feedback, setFeedback] = useState<string | null>(null)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			if (timer.current) clearTimeout(timer.current)
		}
	}, [])
	async function copy(event: React.MouseEvent) {
		event.preventDefault()
		let next = 'Copied'
		try {
			await writeClipboardText(input.prompt)
		} catch {
			next = 'Copy failed'
		}
		if (!mounted.current) return
		setFeedback(next)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => setFeedback(null), 2000)
	}

	const tooltipId = `${input.testId}-tooltip`
	const copyAttrs = {
		'data-testid': input.testId,
		'data-copy-prompt': '',
		'data-copy-text': input.prompt,
		'data-copy-tooltip': input.tooltip,
		'aria-describedby': tooltipId,
		...(input.tone === 'outdated' ? { 'data-fork-outdated-copy': '' } : {}),
	}
	const copyMix =
		input.tone === 'outdated'
			? forkOutdatedCopyButtonCss
			: badgeCopyPromptButtonCss
	const children = (
		<>
			{input.label}
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				{feedback ?? input.tooltip}
			</span>
			<span
				role="status"
				style={{
					position: 'absolute',
					width: 1,
					height: 1,
					overflow: 'hidden',
				}}
			>
				{feedback ?? ''}
			</span>
		</>
	)
	if (input.href) {
		return (
			<SiteLink href={input.href} {...copyAttrs} css={copyMix} onClick={copy}>
				{children}
			</SiteLink>
		)
	}
	return (
		<button type="button" {...copyAttrs} css={copyMix} onClick={copy}>
			{children}
		</button>
	)
}

/**
 * Yellow pill that stands in for Installed/Forked when a community listing
 * has been republished ahead of this fork.
 */
export function ForkOutdatedCopyButton(props: ForkOutdatedCopyButtonProps) {
	return renderCopyPromptPill({
		label: 'Fork outdated',
		prompt: props.prompt,
		testId: props.testId,
		tooltip: FORK_OUTDATED_COPY_TOOLTIP,
		tone: 'outdated',
		href: props.href,
	})
}

/**
 * Calm informational pill when the listing pin is an ancestor of the fork
 * tip. Links to the listing files at that pin; no absorb-prompt action.
 */
export function ForkAheadLink(props: ForkAheadLinkProps) {
	return (
		<SiteLink
			href={props.href}
			data-testid={props.testId}
			title={FORK_AHEAD_TOOLTIP}
			css={forkAheadLinkCss}
		>
			Fork ahead
		</SiteLink>
	)
}

export function renderForkAheadPill(input: { href: string; testId: string }) {
	return (
		<SiteLink
			href={input.href}
			data-testid={input.testId}
			title={FORK_AHEAD_TOOLTIP}
			css={forkAheadLinkCss}
		>
			Fork ahead
		</SiteLink>
	)
}

export const copyPromptTooltipCss = {
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.45rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		maxWidth: 'min(16rem, calc(100vw - 2rem))',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		fontWeight: 400,
		lineHeight: 1.4,
		textAlign: 'left' as const,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 2,
		whiteSpace: 'normal' as const,
	},
	'& [role="tooltip"]::after': {
		content: '""',
		position: 'absolute' as const,
		top: '100%',
		left: '50%',
		transform: 'translateX(-50%)',
		border: '6px solid transparent',
		borderTopColor: colors.surface,
	},
	[hoverMq]: {
		'&:hover [role="tooltip"]': {
			opacity: 1,
			visibility: 'visible' as const,
		},
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
	'&[data-tooltip-dismissed] [role="tooltip"]': {
		opacity: 0,
		visibility: 'hidden' as const,
	},
} satisfies CSSObject

const copyPromptButtonBaseCss = {
	...communityStatusPillBoxCss,
	position: 'relative' as const,
	zIndex: 1,
	appearance: 'none' as const,
	cursor: 'pointer',
	textDecoration: 'none',
	...copyPromptTooltipCss,
} satisfies CSSObject

/*
 * CSS hover/focus tooltip (same grammar as onboarding Copy prompt): a
 * top-layer popover would steal pointer events from neighboring pills.
 * `pointer-events: none` keeps the tip from becoming a hover target.
 * `z-index` lifts the control above a listing card's stretched name-link
 * overlay so the click hits the button instead of the card.
 */
const forkOutdatedCopyButtonCss = mergeCss(copyPromptButtonBaseCss, {
	color: 'oklch(0.48 0.12 85)',
	backgroundColor: 'oklch(0.88 0.12 95 / 0.92)',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: 'oklch(0.84 0.13 95)',
		},
	},
	'&:focus-visible': {
		outline: `2px solid oklch(0.7 0.14 90)`,
		outlineOffset: '2px',
	},
})

const badgeCopyPromptButtonCss = mergeCss(copyPromptButtonBaseCss, {
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
	[hoverMq]: {
		'&:hover': {
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.2)`,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
})

const forkAheadLinkCss = mergeCss(communityStatusPillBoxCss, {
	position: 'relative' as const,
	zIndex: 1,
	textDecoration: 'none',
	color: colors.textMuted,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			borderColor: colors.textMuted,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.border}`,
		outlineOffset: '2px',
	},
})
