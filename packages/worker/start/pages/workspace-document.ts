import { Plugin } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { fileIdSchema } from '#universal/files.ts'
import { blocksToDocument as pageDocument } from '#universal/workspace-page-document.ts'
import type { PageBlock } from '#universal/workspace-page.ts'

export { documentToBlocks } from '#universal/workspace-page-document.ts'

export function blocksToDocument(blocks: PageBlock[]) {
	return pageDocument(
		blocks.length
			? blocks
			: [{ id: crypto.randomUUID(), kind: 'paragraph', text: '' }],
	)
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
