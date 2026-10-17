/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useRef, useState, type ReactNode } from 'react'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAuthInputCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'

type Slot = ReactNode

/*
 * Toolbar controls. These came out of a sidebar that stacked a visible label
 * over each field and spent ~230px of height on three of them; on one row
 * they cost 48px, so the label becomes the control's accessible name.
 */

/** Keep typing immediate while the owning navigation commits its search value. */
export function RecordTableSearch(props: {
	label: string
	placeholder: string
	value: string
	onInput: (value: string) => void | Promise<void>
}) {
	const [draft, setDraft] = useState<string | null>(null)
	const edit = useRef(0)
	function update(value: string) {
		const submitted = ++edit.current
		setDraft(value)
		const settled = () => {
			if (edit.current === submitted) setDraft(null)
		}
		try {
			const pending = props.onInput(value)
			if (pending) void pending.then(settled, settled)
			else settled()
		} catch (error) {
			settled()
			throw error
		}
	}
	return (
		<input
			type="text"
			role="searchbox"
			inputMode="search"
			autoComplete="off"
			autoCorrect="off"
			spellCheck={false}
			data-field-ring
			value={draft ?? props.value}
			placeholder={props.placeholder}
			aria-label={props.label}
			onChange={(event) => update(event.currentTarget.value)}
			css={{
				...getAuthInputCss(),
				appearance: 'none',
				WebkitAppearance: 'none',
				flex: '1 1 12rem',
				minWidth: '7rem',
				width: 'auto',
			}}
		/>
	)
}

export function RecordTableSelect(props: {
	label: string
	value: string
	onChange: (value: string) => void
	children: Slot
}) {
	return (
		<select
			data-field-ring
			value={props.value}
			aria-label={props.label}
			onChange={(event) =>
				props.onChange((event.currentTarget as HTMLSelectElement).value)
			}
			css={{
				...getSelectCss(),
				width: 'auto',
				flex: 'none',
				'@container (max-width: 620px)': { flex: '1 1 8rem' },
			}}
		>
			{props.children}
		</select>
	)
}

/**
 * One-line cell text with an ellipsis. A table cell will not shrink below its
 * content, so the clamp has to live on a block inside it — and the width is
 * `min(…, 100%)` because below 620px that block sits in a card that can be
 * narrower than the clamp itself.
 */
export function recordCellClamp(ch: number) {
	return {
		display: 'block',
		minWidth: 0,
		maxWidth: `min(${ch}ch, 100%)`,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	}
}

/** Date/duration cell: one token, aligned figures, quieter than the name. */
export const recordStampCss: CSSObject = {
	display: 'block',
	minWidth: 0,
	maxWidth: '100%',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	fontVariantNumeric: 'tabular-nums',
	color: colors.textMuted,
	fontSize: '0.84rem',
}

export const visuallyHiddenCss: CSSObject = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
}

/**
 * A boolean column reads as a mark you can scan down, not a word you have to
 * read on every row. The title carries the meaning for anyone who needs it.
 */
export function RecordDot(props: { active: boolean; title: string }) {
	return (
		<span
			title={props.title}
			css={{
				display: 'inline-grid',
				placeContent: 'center',
				width: '1.2rem',
				height: '1.2rem',
				borderRadius: radius.full,
				border: `1px solid ${props.active ? colors.primary : colors.border}`,
				backgroundColor: props.active ? colors.primarySoft : 'transparent',
				color: props.active ? colors.primaryText : colors.textMuted,
				fontSize: '0.68rem',
			}}
		>
			<span aria-hidden="true">{props.active ? '●' : '–'}</span>
			<span css={visuallyHiddenCss}>{props.title}</span>
		</span>
	)
}

const chipCss: CSSObject = {
	display: 'inline-block',
	padding: `0 ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	lineHeight: '1.5rem',
	whiteSpace: 'nowrap' as const,
}

const activeChipCss: CSSObject = {
	...chipCss,
	borderColor: colors.primary,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

/** Tags, roles, scopes — a short set of labels in one cell or one band field. */
export function RecordChips(props: {
	items: Array<string>
	active?: boolean
	empty?: string
}) {
	{
		if (props.items.length === 0) {
			return props.empty ? (
				<span css={{ color: colors.textMuted }}>{props.empty}</span>
			) : null
		}
		return (
			<span
				css={{
					display: 'flex',
					gap: '0.3rem',
					flexWrap: 'wrap',
					overflow: 'hidden',
				}}
			>
				{props.items.map((item) => (
					<span key={item} css={props.active ? activeChipCss : chipCss}>
						{item}
					</span>
				))}
			</span>
		)
	}
}
