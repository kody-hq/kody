import { EditorState } from '@tiptap/pm/state'
import { expect, test } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import {
	blocksToDocument,
	documentToBlocks,
	stableBlockIdsPlugin,
} from './workspace-document.ts'
import { type PageBlock } from '#universal/workspace-page.ts'
const schema = new Schema({
	nodes: {
		doc: { content: 'block+' },
		workspaceText: {
			group: 'block',
			content: 'inline*',
			attrs: {
				id: { default: null },
				kind: { default: 'paragraph' },
				checked: { default: null },
			},
		},
		workspaceFile: {
			group: 'block',
			atom: true,
			attrs: { id: { default: null }, fileId: { default: null } },
		},
		text: { group: 'inline' },
		hardBreak: { inline: true, group: 'inline' },
	},
})
test('the editor preserves block identities, kinds, line breaks, tasks, and file references', () => {
	const blocks: PageBlock[] = [
		...(['paragraph', 'heading', 'bullet', 'quote', 'code'] as const).map(
			(kind) => ({ id: crypto.randomUUID(), kind, text: 'First\n\nLast\n' }),
		),
		{ id: crypto.randomUUID(), kind: 'task', text: 'Check', checked: true },
		{ id: crypto.randomUUID(), kind: 'file', fileId: crypto.randomUUID() },
	]
	expect(
		documentToBlocks(schema.nodeFromJSON(blocksToDocument(blocks))),
	).toEqual(blocks)
})
test('an empty page starts with a writable empty paragraph', () => {
	const blocks = documentToBlocks(schema.nodeFromJSON(blocksToDocument([])))
	expect(blocks).toEqual([
		{ id: expect.any(String), kind: 'paragraph', text: '' },
	])
})

test('pasting before a block gives the copy a new ID and preserves the original identity', () => {
	const id = crypto.randomUUID()
	const doc = schema.nodeFromJSON(
		blocksToDocument([{ id, kind: 'paragraph', text: 'Original' }]),
	)
	const state = EditorState.create({
		schema,
		doc,
		plugins: [stableBlockIdsPlugin()],
	})
	const pasted = schema.nodeFromJSON(
		blocksToDocument([{ id, kind: 'paragraph', text: 'Copy' }]),
	).firstChild!
	const next = state.applyTransaction(state.tr.insert(0, pasted)).state
	const blocks = documentToBlocks(next.doc)
	expect(blocks[0]).toMatchObject({ text: 'Copy' })
	expect(blocks[0]!.id).not.toBe(id)
	expect(blocks[1]).toEqual({ id, kind: 'paragraph', text: 'Original' })
})
