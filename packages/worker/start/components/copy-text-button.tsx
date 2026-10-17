/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useEffect, useId, useState, useRef, type ReactNode } from 'react'
import { writeClipboardText } from '#client/clipboard.ts'
import {
	getChipButtonCss,
	getGhostButtonCss,
	getPillButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	getSwapLabelCss,
} from '#universal/styles/style-primitives.ts'

export const onboardingCopiedConnectActionEvent =
	'kody-onboarding-connect-copied'

type CopyTextButtonProps = {
	value: string
	idleLabel?: ReactNode
	copiedLabel?: string
	class?: string
	/**
	 * `pill` is the redesign's display-face pill (prompt-block copy);
	 * `ghost` its bordered transparent sibling (snippet copy); `chip` the
	 * value-sized control that rides along with an id.
	 */
	variant?: 'primary' | 'secondary' | 'pill' | 'ghost' | 'chip'
	/**
	 * `sm` is the in-page action size the account and admin areas use.
	 * Applies to the `pill` and `ghost` variants.
	 */
	size?: 'md' | 'sm'
	/**
	 * Names the button when its own label cannot. A metadata band carries one
	 * copy button per id, and a screen reader's button list of six identical
	 * "Copy" entries says nothing about which id each one takes.
	 */
	ariaLabel?: string
	/**
	 * Onboarding connect only: copying this command is a deliberate connect
	 * action, so the wizard may start waiting on the grant.
	 */
	signalsConnectAction?: boolean
}

type CopyState = 'idle' | 'copied' | 'error'

const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
} satisfies CSSObject

// css() is static after hydration, so all variants are prebuilt and the
// dynamic state flows through data attributes on the labels, never through
// swapped style objects.
const primaryCopyButtonCss = [getPrimaryButtonCss(), getSwapLabelCss()]
const secondaryCopyButtonCss = [getSecondaryButtonCss(), getSwapLabelCss()]
const pillCopyButtonCss = [getPillButtonCss(), getSwapLabelCss()]
const ghostCopyButtonCss = [getGhostButtonCss(), getSwapLabelCss()]
const chipCopyButtonCss = [getChipButtonCss(), getSwapLabelCss()]

const smallPillCopyButtonCss = [
	getPillButtonCss({ size: 'sm' }),
	getSwapLabelCss(),
]
const smallGhostCopyButtonCss = [
	getGhostButtonCss({ size: 'sm' }),
	getSwapLabelCss(),
]

const copyButtonCssByVariant = {
	primary: primaryCopyButtonCss,
	secondary: secondaryCopyButtonCss,
	pill: pillCopyButtonCss,
	ghost: ghostCopyButtonCss,
	chip: chipCopyButtonCss,
} as const

const smallCopyButtonCssByVariant = {
	pill: smallPillCopyButtonCss,
	ghost: smallGhostCopyButtonCss,
} as const

function getCopyButtonCss(
	variant: NonNullable<CopyTextButtonProps['variant']>,
	size: CopyTextButtonProps['size'],
) {
	if (size === 'sm' && (variant === 'pill' || variant === 'ghost')) {
		return smallCopyButtonCssByVariant[variant]
	}
	return copyButtonCssByVariant[variant]
}

/**
 * Button that copies `value` to the clipboard and shows transient
 * "Copied" / "Copy failed" feedback before returning to the idle label.
 * All three labels stay grid-stacked in the same cell so the button never
 * changes size when the label swaps — the swap is a blur crossfade instead.
 */
export function CopyTextButton(props: CopyTextButtonProps) {
	const [copyState, setCopyState] = useState<CopyState>('idle')
	const id = useId()
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(
		() => () => {
			if (resetTimer.current !== null) clearTimeout(resetTimer.current)
		},
		[],
	)

	async function copyValue(source: EventTarget | null) {
		try {
			await writeClipboardText(props.value)
			setCopyState('copied')
			if (props.signalsConnectAction && source instanceof HTMLElement) {
				source.dispatchEvent(
					new CustomEvent(onboardingCopiedConnectActionEvent, {
						bubbles: true,
					}),
				)
			}
		} catch {
			setCopyState('error')
		}
		if (resetTimer.current != null) clearTimeout(resetTimer.current)
		resetTimer.current = setTimeout(() => {
			resetTimer.current = null
			setCopyState('idle')
		}, 2000)
	}

	function renderLabel(state: CopyState, text: ReactNode) {
		const active = copyState === state
		return (
			<span
				data-swap-label
				data-active={active ? 'true' : undefined}
				aria-hidden={active ? undefined : 'true'}
			>
				{text}
			</span>
		)
	}

	return (
		<button
			type="button"
			className={props.class}
			aria-label={props.ariaLabel}
			// The result is announced by the live region below rather than by the
			// button's own name: `aria-label` overrides the label text, so a named
			// button would keep reading "Copy package id" after it had copied.
			aria-describedby={`${id}-copy-status`}
			css={getCopyButtonCss(props.variant ?? 'primary', props.size)}
			onClick={(event) => {
				const source = event.currentTarget
				void copyValue(source instanceof EventTarget ? source : null)
			}}
		>
			{renderLabel('idle', props.idleLabel ?? 'Copy')}
			{renderLabel('copied', props.copiedLabel ?? 'Copied')}
			{renderLabel('error', 'Copy failed')}
			<span id={`${id}-copy-status`} role="status" css={visuallyHiddenCss}>
				{copyState === 'copied'
					? (props.copiedLabel ?? 'Copied')
					: copyState === 'error'
						? 'Copy failed'
						: ''}
			</span>
		</button>
	)
}
