import { Plugin } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { fileIdSchema } from '#universal/files.ts'
import { type JSONContent } from '@tiptap/core'
import { type Node as DocumentNode } from '@tiptap/pm/model'
import { type PageBlock } from '#universal/workspace-page.ts'

export function blocksToDocument(blocks: PageBlock[]): JSONContent {
	return {
		type: 'doc',
		content: (blocks.length
			? blocks
			: [{ id: crypto.randomUUID(), kind: 'paragraph' as const, text: '' }]
		).map((block) =>
			block.kind === 'file'
				? {
						type: 'workspaceFile',
						attrs: { id: block.id, fileId: block.fileId },
					}
				: {
						type: 'workspaceText',
						attrs: {
							id: block.id,
							kind: block.kind,
							checked: block.checked ?? null,
						},
						content: block.text
							.split('\n')
							.flatMap((text, index) => [
								...(index ? [{ type: 'hardBreak' }] : []),
								...(text ? [{ type: 'text', text }] : []),
							]),
					},
		),
	}
}
export function documentToBlocks(doc: DocumentNode): PageBlock[] {
	const blocks: PageBlock[] = []
	doc.forEach((node) => {
		if (node.type.name === 'workspaceFile')
			blocks.push({
				id: node.attrs.id,
				kind: 'file',
				fileId: node.attrs.fileId,
			})
		else
			blocks.push({
				id: node.attrs.id,
				kind: node.attrs.kind,
				text: node.textBetween(0, node.content.size, '\n', '\n'),
				...(node.attrs.checked !== null ? { checked: node.attrs.checked } : {}),
			})
	})
	return blocks
}

export function stableBlockIdsPlugin() {
	return new Plugin({
		filterTransaction: (tr) => tr.doc.childCount <= 250,
		appendTransaction: (transactions, old, state) => {
			if (!transactions.some((tr) => tr.docChanged)) return null
			const mapping = new Mapping()
			for (const transaction of transactions)
				mapping.appendMapping(transaction.mapping)
			const original = new Map<string, number>()
			old.doc.forEach((node, pos) => original.set(node.attrs.id, pos))
			const groups = new Map<string, number[]>()
			state.doc.forEach((node, pos) =>
				groups.set(node.attrs.id, [...(groups.get(node.attrs.id) ?? []), pos]),
			)
			const tr = state.tr
			for (const [id, positions] of groups) {
				const oldPos = original.get(id)
				const mapped =
					oldPos === undefined ? undefined : mapping.mapResult(oldPos, 1)
				const keep = fileIdSchema.safeParse(id).success
					? mapped && !mapped.deleted && positions.includes(mapped.pos)
						? mapped.pos
						: positions[0]
					: undefined
				for (const pos of positions)
					if (pos !== keep)
						tr.setNodeMarkup(pos, undefined, {
							...tr.doc.nodeAt(pos)!.attrs,
							id: crypto.randomUUID(),
						})
			}
			return tr.docChanged ? tr : null
		},
	})
}
