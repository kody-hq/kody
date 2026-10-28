/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { Combobox, type ComboboxOption } from './combobox.tsx'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'

const removeButtonCss = getGhostButtonCss({ size: 'sm' })
const identityCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	'& code': {
		color: colors.textMuted,
		overflowWrap: 'anywhere' as const,
	},
}
const rowCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	gap: spacing.sm,
	alignItems: 'center',
	padding: spacing.sm,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
}
const mutedCss = { margin: 0, color: colors.textMuted }

/**
 * A package lock list: the selected packages, each removable, plus a
 * searchable picker for the rest. Selected ids missing from `options` stay
 * listed (with `unknownLabel`) so they can still be removed.
 */
export function AllowedPackagesPicker(props: {
	id: string
	placeholder?: string
	options: ReadonlyArray<ComboboxOption>
	selected: ReadonlyArray<string>
	unknownLabel: ReactNode
	emptyText?: ReactNode
	allSelectedText: ReactNode
	noOptionsText?: ReactNode
	onAdd: (packageId: string) => void
	onRemove: (packageId: string) => void
}) {
	const byId = new Map(props.options.map((option) => [option.id, option]))
	const available = props.options.filter(
		(option) => !props.selected.includes(option.id),
	)
	return (
		<div css={{ display: 'grid', gap: spacing.sm }}>
			{props.selected.length > 0 ? (
				<ul
					aria-label="Allowed packages"
					css={{
						display: 'grid',
						gap: spacing.sm,
						listStyle: 'none',
						margin: 0,
						padding: 0,
					}}
				>
					{props.selected.map((packageId) => {
						const option = byId.get(packageId)
						const label = option?.label ?? packageId
						return (
							<li key={packageId} css={rowCss}>
								<span css={identityCss}>
									<strong>{option ? option.label : props.unknownLabel}</strong>
									<code>{packageId}</code>
								</span>
								<button
									type="button"
									aria-label={`Remove package ${label}`}
									onClick={() => props.onRemove(packageId)}
									css={removeButtonCss}
								>
									Remove
								</button>
							</li>
						)
					})}
				</ul>
			) : props.emptyText ? (
				<p css={mutedCss}>{props.emptyText}</p>
			) : null}
			{available.length > 0 ? (
				<Combobox
					key={`${props.id}:${props.selected.join(',')}`}
					id={props.id}
					label="Add allowed package"
					placeholder={props.placeholder ?? 'Search packages'}
					value=""
					options={available}
					onChange={(packageId) => {
						if (packageId) props.onAdd(packageId)
					}}
				/>
			) : props.options.length > 0 ? (
				<p css={mutedCss}>{props.allSelectedText}</p>
			) : props.noOptionsText ? (
				<p css={mutedCss}>{props.noOptionsText}</p>
			) : null}
		</div>
	)
}
