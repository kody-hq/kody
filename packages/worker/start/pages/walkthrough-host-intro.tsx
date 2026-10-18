/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'

import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import {
	listWalkthroughHostOptions,
	replaceWalkthroughHost,
	walkthroughHostMarkUrl,
	walkthroughHostSlotLabel,
	type WalkthroughHostPick,
	type WalkthroughHostSlot,
} from '#universal/walkthrough-hosts.ts'
import { colors, radius } from '#universal/styles/tokens.ts'

/**
 * Story setup for the How Kody works transcript and the homepage loop.
 * `sentence` is the guide lead. `picker` is the homepage chooser.
 * Changing a select updates conversation marks through `onHostsChange`.
 * Native option markup must survive HTML parsing in every supported browser.
 * The selected agent mark sits outside the select for the same reason.
 *
 * Keep browser translators from replacing the live select and label nodes
 * while host selection updates the transcript (KODY-7N).
 */
export function WalkthroughHostIntro(props: {
	hosts: WalkthroughHostPick
	onHostsChange: (hosts: WalkthroughHostPick) => void
	variant?: 'sentence' | 'picker'
}) {
	function changeSlot(slot: WalkthroughHostSlot, hostId: string) {
		const next = replaceWalkthroughHost(props.hosts, slot, hostId)
		if (next === props.hosts) return
		props.onHostsChange(next)
	}

	const hosts = props.hosts
	if (props.variant === 'picker') {
		return (
			<div translate="no" className="notranslate" css={pickerCss}>
				<p css={pickerLeadCss}>Choose three agents you use:</p>
				<p css={pickerSentenceCss}>
					I use {renderHostSelect(hosts, 'coding', changeSlot)} for daily
					coding, {renderHostSelect(hosts, 'invoke', changeSlot)} for phone
					chat, and sometimes {renderHostSelect(hosts, 'notify', changeSlot)}{' '}
					for coding too.
				</p>
			</div>
		)
	}
	return (
		<span translate="no" className="notranslate">
			Let&apos;s say you use {renderHostSelect(hosts, 'coding', changeSlot)} as
			your regular coding agent, {renderHostSelect(hosts, 'invoke', changeSlot)}{' '}
			as your chat agent on your phone, and{' '}
			{renderHostSelect(hosts, 'notify', changeSlot)} as another agent you
			sometimes use. Here&apos;s an example of conversations you might have with
			them when they&apos;re connected to Kody.
		</span>
	)
}

function renderHostSelect(
	hosts: WalkthroughHostPick,
	slot: WalkthroughHostSlot,
	onChange: (slot: WalkthroughHostSlot, hostId: string) => void,
	label: string = walkthroughHostSlotLabel(slot),
) {
	const selected = hosts[slot]
	const options = listWalkthroughHostOptions(hosts, slot)
	return (
		<span
			css={{
				display: 'inline-block',
				position: 'relative',
				verticalAlign: 'middle',
				maxWidth: '100%',
			}}
		>
			<span
				css={{
					...optionMarkCss,
					position: 'absolute',
					left: '0.65em',
					top: '50%',
					transform: 'translateY(-50%)',
					pointerEvents: 'none',
				}}
				className="walkthrough-host-mark"
				style={
					{
						'--chip-icon': `url("${publicAsset(walkthroughHostMarkUrl(selected))}")`,
					} as CSSProperties
				}
				aria-hidden="true"
			/>
			<select
				aria-label={label}
				value={selected.id}
				translate="no"
				className="notranslate"
				css={selectCss}
				onChange={(event) => onChange(slot, event.currentTarget.value)}
			>
				{options.map((host) => (
					<option key={host.id} value={host.id}>
						{host.label}
					</option>
				))}
			</select>
		</span>
	)
}

const pickerCss = {
	display: 'grid',
	gap: '0.7rem',
} satisfies CSSObject

const pickerLeadCss = {
	margin: 0,
	color: colors.text,
	fontWeight: 650,
} satisfies CSSObject

const pickerSentenceCss = {
	margin: 0,
	lineHeight: 1.7,
} satisfies CSSObject

const nativeSelectCss = {
	appearance: 'none' as const,
	WebkitAppearance: 'none' as const,
	paddingRight: '1.35em',
	backgroundImage: 'var(--select-chevron)',
	backgroundRepeat: 'no-repeat',
	backgroundPosition: 'right 0.35em center',
	backgroundSize: '0.75em',
} satisfies CSSObject

const optionMarkCss = {
	width: '0.85em',
	height: '0.85em',
	flex: 'none',
	background: 'currentColor',
	maskImage: 'var(--chip-icon)',
	maskPosition: 'center',
	maskSize: 'contain',
	maskRepeat: 'no-repeat',
	WebkitMaskImage: 'var(--chip-icon)',
	WebkitMaskPosition: 'center',
	WebkitMaskSize: 'contain',
	WebkitMaskRepeat: 'no-repeat',
} satisfies CSSObject

// Keep the select native, including in browsers that support customizable selects.
const selectCss = {
	...nativeSelectCss,
	display: 'inline-block',
	verticalAlign: 'middle' as const,
	maxWidth: '100%',
	minHeight: '24px',
	margin: '0 0.15em',
	padding: '0.15em 1.35em 0.15em 1.65em',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	color: colors.text,
	font: 'inherit',
	fontWeight: 650,
	lineHeight: 1,
	cursor: 'pointer',
	'&:hover, &:focus-visible': {
		borderColor: colors.primary,
		color: colors.primaryText,
	},
} satisfies CSSObject
