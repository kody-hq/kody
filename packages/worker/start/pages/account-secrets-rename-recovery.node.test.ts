import { expect, test } from 'vitest'
import {
	applyStuckRenameRecovery,
	createEmptyEditorState,
} from './account-secrets-shared.ts'
test.each(['user', 'package'] as const)(
	'rename recovery keeps the submitted %s scope and edits the committed casing',
	(scope) => {
		const editor = {
			...createEmptyEditorState([]),
			currentId: `${scope}::::Henry`,
			name: 'henry',
			scope,
			packageId: scope === 'package' ? 'pkg-1' : '',
			value: 'replacement',
		}
		const stuck = {
			id: scope === 'package' ? 'package::pkg-1::henry' : 'user::::henry',
			name: 'henry',
		}
		const recovered = applyStuckRenameRecovery({
			editor,
			stuck,
			search: '?q=henry',
		})
		expect(recovered.editor).toEqual({
			...editor,
			currentId: stuck.id,
			name: 'henry',
		})
		expect(recovered.href).toContain('henry')
		expect(recovered.href).toContain('?q=henry')
		expect(recovered.href).not.toContain('Henry')
		if (scope === 'package') expect(recovered.href).toContain('pkg-1')
	},
)
