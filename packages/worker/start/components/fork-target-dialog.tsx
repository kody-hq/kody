/** @jsxImportSource @emotion/react */
import { Button } from './button.tsx'
import { useState } from 'react'
import type { ForkTargetChoice } from '../fork-target.ts'
import { installOrgOptionLabel } from './community-install-org-select.tsx'
import { renderIcon } from './icon.tsx'
import { spacing } from '#universal/styles/tokens.ts'
import { Dialog, DialogActions } from './dialog.tsx'
import { Field } from './field.tsx'
import { Select } from './input.tsx'

/**
 * Asks which org a fork goes into when the viewer can fork into more than
 * one. Escape and an outside click cancel, and closing returns focus to the
 * Fork button.
 */
export function ForkTargetDialog(props: {
	choice: ForkTargetChoice
	onConfirm: (slug: string) => void
	onDismiss: () => void
}) {
	const [selected, setSelected] = useState(props.choice.selected)
	return (
		<Dialog
			open
			onClose={props.onDismiss}
			dismissOnOutsideClick
			title="Fork into"
			description="The fork runs and bills in the workspace you pick."
			data-testid="fork-target-dialog"
		>
			<form
				css={formCss}
				onSubmit={(event) => {
					event.preventDefault()
					props.onConfirm(selected)
					props.onDismiss()
				}}
			>
				<Field label="Workspace">
					<Select
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
				</Field>
				<DialogActions>
					<Button
						type="button"
						data-testid="fork-target-cancel"
						variant="secondary"
						onClick={props.onDismiss}
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
				</DialogActions>
			</form>
		</Dialog>
	)
}

const formCss = { display: 'grid', gap: spacing.md } as const
