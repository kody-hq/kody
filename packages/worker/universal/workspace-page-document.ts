import type { JSONContent } from '@tiptap/core'
import type { Node as DocumentNode, NodeSpec } from '@tiptap/pm/model'
import type { PageBlock } from './workspace-page.ts'

export const workspaceContentsNode = {
	group: 'block',
	atom: true,
	attrs: { id: { default: null } },
} satisfies NodeSpec

export const workspaceTextAttributes = {
	id: { default: null },
	kind: { default: 'paragraph' },
	checked: { default: null },
	title: { default: null },
}

const tableCellAttributes = {
	colspan: { default: 1 },
	rowspan: { default: 1 },
	colwidth: { default: null },
}

export const workspaceTableNodes = {
	workspaceTable: {
		group: 'block',
		content: 'workspaceTableRow+',
		tableRole: 'table',
		attrs: { id: { default: null } },
	},
	workspaceTableRow: {
		content: '(workspaceTableCell | workspaceTableHeader)+',
		tableRole: 'row',
	},
	workspaceTableCell: {
		content: 'inline*',
		tableRole: 'cell',
		isolating: true,
		attrs: tableCellAttributes,
	},
	workspaceTableHeader: {
		content: 'inline*',
		tableRole: 'header_cell',
		isolating: true,
		attrs: tableCellAttributes,
	},
} satisfies Record<string, NodeSpec>

export function inlineContent(value: string): JSONContent[] {
	return value
		.split('\n')
		.flatMap((text, index) => [
			...(index ? [{ type: 'hardBreak' }] : []),
			...(text ? [{ type: 'text', text }] : []),
		])
}

export function blocksToDocument(blocks: PageBlock[]): JSONContent {
	return {
		type: 'doc',
		content: blocks.map((block) => {
			if (block.kind === 'file')
				return {
					type: 'workspaceFile',
					attrs: { id: block.id, fileId: block.fileId },
				}
			if (block.kind === 'contents')
				return { type: 'workspaceContents', attrs: { id: block.id } }
			if (block.kind === 'table')
				return {
					type: 'workspaceTable',
					attrs: { id: block.id },
					content: block.rows.map((row, index) => ({
						type: 'workspaceTableRow',
						content: row.map((cell) => ({
							type: index === 0 ? 'workspaceTableHeader' : 'workspaceTableCell',
							content: inlineContent(cell),
						})),
					})),
				}
			return {
				type: 'workspaceText',
				attrs: {
					id: block.id,
					kind: block.kind,
					checked: 'checked' in block ? block.checked : null,
					title: 'title' in block ? block.title : null,
				},
				content: inlineContent(block.text),
			}
		}),
	}
}

function plainText(node: DocumentNode) {
	return node.textBetween(0, node.content.size, '\n', '\n')
}

export function documentToBlocks(doc: DocumentNode): PageBlock[] {
	const blocks: PageBlock[] = []
	doc.forEach((node) => {
		const { id, kind, checked, title, fileId } = node.attrs
		if (node.type.name === 'workspaceFile') {
			blocks.push({ id, kind: 'file', fileId })
		} else if (node.type.name === 'workspaceContents') {
			blocks.push({ id, kind: 'contents' })
		} else if (node.type.name === 'workspaceTable') {
			const rows: string[][] = []
			node.forEach((row) => {
				const cells: string[] = []
				row.forEach((cell) => cells.push(plainText(cell)))
				rows.push(cells)
			})
			// Concurrent row and column edits can leave holes before the editor repairs the grid.
			const width = rows.reduce((max, row) => Math.max(max, row.length), 1)
			if (!rows.length) rows.push([])
			for (const row of rows) while (row.length < width) row.push('')
			blocks.push({ id, kind: 'table', rows })
		} else if (kind === 'collapse' || kind === 'link') {
			blocks.push({ id, kind, title: title ?? '', text: plainText(node) })
		} else {
			blocks.push({
				id,
				kind,
				text: plainText(node),
				...(checked != null ? { checked } : {}),
			})
		}
	})
	return blocks
}
