/** @jsxImportSource @emotion/react */
import { Button } from './button.tsx'
import type { CSSObject } from '@emotion/react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ForkTargetChoice } from '../fork-target.ts'
import { installOrgOptionLabel } from './community-install-org-select.tsx'
import { renderIcon } from './icon.tsx'
import { colors, radius, shadows, spacing } from '#universal/styles/tokens.ts'
import { Select } from './input.tsx'

/**
 * Asks which org a fork goes into when the viewer can fork into more than
 * one. A native modal dialog: Tab wraps inside it, Escape and the backdrop cancel,
 * and closing returns focus to the Fork button.
 */
export function ForkTargetDialog(props: {
	choice: ForkTargetChoice
	onConfirm: (slug: string) => void
	onDismiss: () => void
}) {
	const dialog = useRef<HTMLDialogElement>(null)
	const [selected, setSelected] = useState(props.choice.selected)
	const titleId = useId()
	const noteId = useId()
	const selectId = useId()
	useEffect(() => {
		const element = dialog.current
		if (!element) return
		if (!element.open) element.showModal()
		const onBackdrop = (event: MouseEvent) => {
			if (event.target === element) element.close()
		}
		const onTab = (event: KeyboardEvent) => {
			if (event.key !== 'Tab') return
			const focusable = element.querySelectorAll<HTMLElement>(
				'select, button:not([disabled])',
			)
			const first = focusable[0]
			const last = focusable[focusable.length - 1]
			if (!first || !last) return
			const edge = event.shiftKey ? first : last
			if (document.activeElement !== edge) return
			event.preventDefault()
			;(event.shiftKey ? last : first).focus()
		}
		element.addEventListener('click', onBackdrop)
		element.addEventListener('keydown', onTab)
		return () => {
			element.removeEventListener('click', onBackdrop)
			element.removeEventListener('keydown', onTab)
		}
	}, [])
	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			aria-describedby={noteId}
			data-testid="fork-target-dialog"
			css={dialogCss}
			onClose={props.onDismiss}
		>
			<form
				method="dialog"
				css={formCss}
				onSubmit={(event) => {
					event.preventDefault()
					props.onConfirm(selected)
					dialog.current?.close()
				}}
			>
				<h2 id={titleId} css={titleCss}>
					Fork into
				</h2>
				<p id={noteId} css={noteCss}>
					The fork runs and bills in the workspace you pick.
				</p>
				<div css={fieldCss}>
					<label htmlFor={selectId} css={labelCss}>
						Workspace
					</label>
					<Select
						id={selectId}
						data-testid="fork-target-org"
						autoFocus
						value={selected}
						onChange={(event) => setSelected(event.currentTarget.value)}
					>
						{props.choice.owners.map((owner) => (
							<option key={owner.slug} value={owner.slug}>
								{installOrgOptionLabel(owner)}
							</option>
						))}
					</Select>
				</div>
				<div css={actionsCss}>
					<Button
						type="button"
						data-testid="fork-target-cancel"
						variant="secondary"
						onClick={() => dialog.current?.close()}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						data-testid="fork-target-confirm"
						variant="primary"
					>
						{renderIcon('git-fork', { size: '1.05em' })}
						Fork
					</Button>
				</div>
			</form>
		</dialog>
	)
}

const dialogCss: CSSObject = {
	width: 'min(28rem, calc(100vw - 2rem))',
	maxWidth: '28rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.45)',
	},
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
}

const titleCss: CSSObject = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}

const noteCss: CSSObject = {
	margin: 0,
	fontSize: '0.92rem',
	color: colors.textMuted,
}

const fieldCss: CSSObject = {
	display: 'grid',
	gap: '0.45rem',
	minWidth: 0,
}

const labelCss: CSSObject = {
	fontSize: '0.92rem',
	fontWeight: 600,
	color: colors.text,
}

const actionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	justifyContent: 'flex-end',
	gap: '0.7rem',
}
