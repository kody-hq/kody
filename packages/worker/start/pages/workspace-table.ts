import { Extension, Node } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { goToNextCell, tableEditing } from '@tiptap/pm/tables'
import { workspaceTableNodes } from '#universal/workspace-page-document.ts'

export const WorkspaceTables = Extension.create({
	name: 'workspaceTables',
	priority: 110,
	extendNodeSchema(extension) {
		const name = extension.name as keyof typeof workspaceTableNodes
		return Object.hasOwn(workspaceTableNodes, name)
			? { tableRole: workspaceTableNodes[name].tableRole }
			: {}
	},
	addProseMirrorPlugins() {
		return [
			new Plugin({
				appendTransaction(transactions, _previous, state) {
					if (!transactions.some((transaction) => transaction.docChanged))
						return null
					const tr = state.tr
					const { workspaceTableCell, workspaceTableHeader } =
						state.schema.nodes
					state.doc.forEach((table, tablePos) => {
						if (table.type.name !== 'workspaceTable') return
						table.forEach((row, rowPos, index) => {
							const type =
								index === 0 ? workspaceTableHeader : workspaceTableCell
							row.forEach((cell, cellPos) => {
								if (cell.type !== type)
									tr.setNodeMarkup(
										tablePos + rowPos + cellPos + 2,
										type,
										cell.attrs,
									)
							})
						})
					})
					return tr.docChanged ? tr : null
				},
				props: {
					handlePaste(view, event) {
						const clipboard = event.clipboardData
						if (!clipboard || clipboard.getData('text/html')) return false
						const text = clipboard.getData('text/plain')
						if (!text.includes('\t')) return false
						const rows = text
							.replace(/\r?\n$/, '')
							.split(/\r?\n/)
							.map((row) => row.split('\t'))
						if (!rows.every((row) => row.length === rows[0]?.length))
							return false
						const table = view.dom.ownerDocument.createElement('table')
						const body = table.createTBody()
						for (const row of rows) {
							const tr = body.insertRow()
							for (const value of row) tr.insertCell().textContent = value
						}
						return view.pasteHTML(table.outerHTML)
					},
				},
			}),
			tableEditing(),
		]
	},
	addKeyboardShortcuts() {
		return {
			Enter: () => {
				const role =
					this.editor.state.selection.$from.parent.type.spec.tableRole
				return (
					(role === 'cell' || role === 'header_cell') &&
					this.editor.commands.setHardBreak()
				)
			},
			Tab: () => goToNextCell(1)(this.editor.state, this.editor.view.dispatch),
			'Shift-Tab': () =>
				goToNextCell(-1)(this.editor.state, this.editor.view.dispatch),
		}
	},
})

export const WorkspaceTable = Node.create({
	name: 'workspaceTable',
	group: workspaceTableNodes.workspaceTable.group,
	content: workspaceTableNodes.workspaceTable.content,
	draggable: true,
	addAttributes() {
		return workspaceTableNodes.workspaceTable.attrs
	},
	parseHTML() {
		return [{ tag: 'table' }]
	},
	renderHTML({ HTMLAttributes }) {
		return ['table', HTMLAttributes, ['tbody', 0]]
	},
})

export const workspaceTableParts = (
	[
		['workspaceTableRow', 'tr'],
		['workspaceTableCell', 'td'],
		['workspaceTableHeader', 'th'],
	] as const
).map(([name, tag]) => {
	const spec = workspaceTableNodes[name]
	return Node.create({
		name,
		content: spec.content,
		addAttributes() {
			if ('attrs' in spec)
				return {
					colspan: {
						...spec.attrs.colspan,
						rendered: false,
						parseHTML: () => 1,
					},
					rowspan: {
						...spec.attrs.rowspan,
						rendered: false,
						parseHTML: () => 1,
					},
					colwidth: {
						...spec.attrs.colwidth,
						rendered: false,
						parseHTML: () => null,
					},
				}
			return {}
		},
		parseHTML() {
			return [{ tag }]
		},
		renderHTML() {
			return tag === 'th' ? [tag, { scope: 'col' }, 0] : [tag, 0]
		},
	})
})
