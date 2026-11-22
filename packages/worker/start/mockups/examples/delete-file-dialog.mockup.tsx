/** @jsxImportSource @emotion/react */
import { Button } from '../../components/button.tsx'
import { Dialog, DialogActions } from '../../components/dialog.tsx'
import { Field } from '../../components/field.tsx'
import { Input } from '../../components/input.tsx'
import type { Mockup } from '../mockup.ts'

const noop = () => {}

/** Example: the existing file dialogs, open. Matches the /dev/ui baselines. */
export default {
	title: 'File dialogs (example)',
	description: 'Existing delete and rename dialogs, rendered open',
	shell: 'bare',
	states: {
		delete: () => (
			<Dialog
				open
				onClose={noop}
				role="alertdialog"
				title="Delete notes.md?"
				description="This can't be undone."
			>
				<DialogActions>
					<Button type="button" variant="secondary">
						Cancel
					</Button>
					<Button type="button" variant="danger">
						Delete
					</Button>
				</DialogActions>
			</Dialog>
		),
		rename: () => (
			<Dialog
				open
				onClose={noop}
				title="Rename file"
				description="Names must be unique in this folder."
			>
				<Field label="Name">
					<Input name="name" defaultValue="notes.md" />
				</Field>
				<DialogActions>
					<Button type="button" variant="secondary">
						Cancel
					</Button>
					<Button type="button" variant="primary">
						Save
					</Button>
				</DialogActions>
			</Dialog>
		),
	},
} satisfies Mockup
