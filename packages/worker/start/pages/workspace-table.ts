import { Extension, Node } from '@tiptap/core'
import { Fragment, Slice, type Node as DocumentNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { goToNextCell, tableEditing } from '@tiptap/pm/tables'
import {
	workspaceTableMaxRows,
	workspaceTableMaxColumns,
} from '#universal/workspace-page.ts'
import {
	workspaceTableNodes,
	inlineContent,
} from '#universal/workspace-page-document.ts'

export const workspaceTableLimitMessage = `Tables can have up to ${workspaceTableMaxRows} rows and ${workspaceTableMaxColumns} columns.`

function tableWidth(table: DocumentNode) {
	let width = 0
	table.forEach((row) => {
		width = Math.max(width, row.childCount)
	})
	return width
}

export const WorkspaceTables = Extension.create({
	name: 'workspaceTables',
	priority: 110,
	addOptions() {
		return { onTableLimit: () => {} }
	},
	extendNodeSchema(extension) {
		const name = extension.name as keyof typeof workspaceTableNodes
		return Object.hasOwn(workspaceTableNodes, name)
			? { tableRole: workspaceTableNodes[name].tableRole }
			: {}
	},
	addProseMirrorPlugins() {
		return [
			new Plugin({
				filterTransaction: (transaction, state) => {
					if (!transaction.docChanged || transaction.getMeta(ySyncPluginKey))
						return true
					// Concurrent edits can cross the UI limit. Keep those edits and let
					// users edit or shrink the merged table without growing it further.
					const previous = new Map<string, DocumentNode>()
					state.doc.forEach((table) => {
						if (table.type.name === 'workspaceTable')
							previous.set(table.attrs.id, table)
					})
					let oversized = false
					transaction.doc.forEach((table) => {
						if (table.type.name !== 'workspaceTable' || oversized) return
						const old = previous.get(table.attrs.id)
						const width = tableWidth(table)
						oversized =
							table.childCount >
								Math.max(workspaceTableMaxRows, old?.childCount ?? 0) ||
							width >
								Math.max(workspaceTableMaxColumns, old ? tableWidth(old) : 0)
					})
					if (oversized) queueMicrotask(this.options.onTableLimit)
					return !oversized
				},
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
					handlePaste: (view, event) => {
						const clipboard = event.clipboardData
						if (!clipboard) return false
						const sourceKind = view.state.selection.$from.parent.attrs.kind
						const text = clipboard.getData('text/plain')
						if (text && (sourceKind === 'code' || sourceKind === 'mermaid')) {
							const content = inlineContent(text.replace(/\r\n?/g, '\n')).map(
								(node) => view.state.schema.nodeFromJSON(node),
							)
							view.dispatch(
								view.state.tr
									.replaceSelection(new Slice(Fragment.from(content), 0, 0))
									.scrollIntoView(),
							)
							return true
						}
						if (clipboard.getData('text/html') || !text.includes('\t'))
							return false
						const rows = text
							.replace(/\r?\n$/, '')
							.split(/\r?\n/)
							.map((row) => row.split('\t'))
						if (!rows.every((row) => row.length === rows[0]?.length))
							return false
						if (
							rows.length > workspaceTableMaxRows ||
							rows[0]!.length > workspaceTableMaxColumns
						) {
							this.options.onTableLimit()
							return true
						}
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
