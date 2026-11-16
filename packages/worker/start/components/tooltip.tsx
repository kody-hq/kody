/** @jsxImportSource @emotion/react */
import { useEffect, useRef, type ReactNode } from 'react'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

export type TooltipProps = {
	/**
	 * Stable id; point the trigger's `aria-describedby` at it. Pass a fixed
	 * string, not `useId`: tree-position ids shift between server and client.
	 */
	id: string
	/** `top` (default) sits above the trigger; `bottom` below it. */
	side?: 'top' | 'bottom'
	/** `start` and `end` anchor to that edge so tips near a gutter stay on screen. */
	align?: 'center' | 'start' | 'end'
	/** Layout overrides only, such as a different edge on mobile. */
	className?: string
	children: ReactNode
}

/**
 * Hover and focus hint. Render it as the last child of its trigger and
 * point the trigger's `aria-describedby` at `id`. It ships in the server
 * HTML, so it works before hydration, and Escape hides it until the
 * pointer or focus leaves (WCAG 1.4.13).
 */
export function Tooltip({
	id,
	side = 'top',
	align = 'center',
	className,
	children,
}: TooltipProps) {
	const ref = useRef<HTMLSpanElement>(null)
	useEffect(() => {
		const trigger = ref.current?.parentElement
		if (!trigger) return
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === 'Escape') trigger!.dataset.tooltipDismissed = ''
		}
		function reset() {
			delete trigger!.dataset.tooltipDismissed
		}
		trigger.addEventListener('keydown', onKeyDown)
		trigger.addEventListener('blur', reset)
		trigger.addEventListener('pointerenter', reset)
		trigger.addEventListener('pointerleave', reset)
		return () => {
			trigger.removeEventListener('keydown', onKeyDown)
			trigger.removeEventListener('blur', reset)
			trigger.removeEventListener('pointerenter', reset)
			trigger.removeEventListener('pointerleave', reset)
		}
	}, [])
	return (
		<span
			ref={ref}
			id={id}
			role="tooltip"
			// Read through the trigger's aria-describedby, not as page text.
			aria-hidden="true"
			className={className}
			css={[tooltipCss, sideCss[side], alignCss[align]]}
		>
			{children}
		</span>
	)
}

const shownCss = { opacity: 1, visibility: 'visible' as const }

const tooltipCss = {
	position: 'absolute' as const,
	zIndex: 2,
	width: 'max-content',
	maxWidth: 'min(16rem, calc(100vw - 2rem))',
	padding: `${spacing.xs} ${spacing.sm}`,
	boxSizing: 'border-box' as const,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: 400,
	lineHeight: 1.4,
	textAlign: 'left' as const,
	whiteSpace: 'normal' as const,
	pointerEvents: 'none' as const,
	opacity: 0,
	visibility: 'hidden' as const,
	'&::after': {
		content: '""',
		position: 'absolute' as const,
		border: '6px solid transparent',
	},
	[hoverMq]: { ':hover > &': shownCss },
	':focus-visible > &': shownCss,
	'[data-tooltip-dismissed] > &': { opacity: 0, visibility: 'hidden' as const },
	// Anchor to the trigger without outranking a trigger's own `position`.
	':where(:has(> &))': { position: 'relative' as const },
}

const sideCss = {
	top: {
		bottom: 'calc(100% + 0.45rem)',
		'&::after': { top: '100%', borderTopColor: colors.surface },
	},
	bottom: {
		top: 'calc(100% + 0.45rem)',
		'&::after': { bottom: '100%', borderBottomColor: colors.surface },
	},
}

const alignCss = {
	center: {
		left: '50%',
		transform: 'translateX(-50%)',
		'&::after': { left: '50%', transform: 'translateX(-50%)' },
	},
	start: { left: 0, '&::after': { left: '1rem' } },
	end: { right: 0, '&::after': { right: '1rem' } },
}
