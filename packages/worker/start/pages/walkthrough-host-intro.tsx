/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'

import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import {
	listWalkthroughHostOptions,
	replaceWalkthroughHost,
	walkthroughHostMarkUrl,
	walkthroughHostSlotLabel,
	type WalkthroughHost,
	type WalkthroughHostPick,
	type WalkthroughHostSlot,
} from '#universal/walkthrough-hosts.ts'
import { colors, radius } from '#universal/styles/tokens.ts'

/**
 * Story setup for the How Kody works transcript and the homepage loop.
 * `sentence` is the guide lead. `picker` is the homepage chooser.
 * Changing a select updates conversation marks through `onHostsChange`.
 * Customizable select is a progressive enhancement; other browsers keep
 * a native select styled as the same inline chip.
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
		<select
			aria-label={label}
			value={selected.id}
			translate="no"
			className="notranslate"
			css={selectCss}
			onChange={(event) => onChange(slot, event.currentTarget.value)}
		>
			<button type="button">{renderHostOption(selected)}</button>
			{options.map((host) => (
				<option key={host.id} value={host.id}>
					{renderHostOption(host)}
				</option>
			))}
		</select>
	)
}

function renderHostOption(host: WalkthroughHost) {
	return (
		<span className="walkthrough-host-option">
			<span
				className="walkthrough-host-mark"
				style={
					{
						'--chip-icon': `url("${publicAsset(walkthroughHostMarkUrl(host))}")`,
					} as CSSProperties
				}
				aria-hidden="true"
			></span>
			{host.label}
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

const optionInnerCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.35em',
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

// Emit all option styles before the select. Inline Emotion style nodes inside
// a customizable select cannot be parsed safely by Cloudflare HTMLRewriter.
const selectCss = {
	'& .walkthrough-host-option': optionInnerCss,
	'& .walkthrough-host-mark': optionMarkCss,
	display: 'inline-flex',
	alignItems: 'center',
	verticalAlign: 'middle' as const,
	maxWidth: '100%',
	minHeight: '24px',
	margin: '0 0.15em',
	padding: '0.15em 0.5em',
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
	'@supports (appearance: base-select)': {
		appearance: 'base-select' as CSSObject['appearance'],
		'& > button': {
			display: 'inline-flex',
			alignItems: 'center',
			minHeight: '24px',
			margin: 0,
			padding: '0.15em 0',
			border: 'none',
			background: 'transparent',
			color: 'inherit',
			font: 'inherit',
			fontWeight: 'inherit',
			lineHeight: 'inherit',
			cursor: 'pointer',
		},
		'&::picker-icon': {
			width: '0.7em',
			height: '0.7em',
			alignSelf: 'center',
			translate: '0 -0.12em',
			color: 'currentColor',
			opacity: 0.7,
		},
		'&::picker(select)': {
			appearance: 'base-select' as CSSObject['appearance'],
			marginTop: '0.35rem',
			padding: '0.35rem',
			border: `1px solid ${colors.border}`,
			borderRadius: radius.lg,
			backgroundColor: colors.surface,
			color: colors.text,
		},
		'& option': {
			padding: '0.4rem 0.55rem',
			borderRadius: radius.md,
			cursor: 'pointer',
		},
		'& option:hover, & option:checked': {
			backgroundColor: colors.primarySoftest,
		},
		'& option::checkmark': {
			display: 'none',
		},
	},
	'@supports not (appearance: base-select)': nativeSelectCss,
} satisfies CSSObject
