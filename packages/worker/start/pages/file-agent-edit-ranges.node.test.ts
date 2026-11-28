import { expect, test } from 'vitest'
import * as Y from 'yjs'
import {
	createCollaborativeDocument,
	replaceCollaborativeContent,
} from '#universal/collaborative-document.ts'
import {
	workspacePageMediaType,
	writeWorkspacePage,
} from '#universal/workspace-page.ts'
import {
	agentEditRanges,
	type AgentEditRange,
} from './file-agent-edit-ranges.ts'

function indexes(doc: Y.Doc, ranges: AgentEditRange[]) {
	return ranges.map(({ start, end }) =>
		[start, end].map(
			(position) =>
				Y.createAbsolutePositionFromRelativePosition(position, doc)?.index,
		),
	)
}

test('agent ranges keep separate edits and track concurrent text insertions', () => {
	const doc = new Y.Doc()
	const author = new Y.Doc()
	try {
		const text = doc.getText('content')
		text.insert(0, 'old and remove')
		Y.applyUpdate(author, Y.encodeStateAsUpdate(doc))
		const edited = author.getText('content')
		author.transact(() => {
			edited.delete(8, 6)
			edited.delete(0, 3)
			edited.insert(0, 'new')
		})
		text.insert(4, 'also ')
		const update = Y.encodeStateAsUpdate(author, Y.encodeStateVector(doc))
		const ranges = agentEditRanges(doc, update)
		expect(text.toString()).toBe('old also and remove')
		expect(indexes(doc, ranges.before)).toEqual([
			[0, 3],
			[13, 19],
		])
		Y.applyUpdate(doc, update)
		expect(text.toString()).toBe('new also and ')
		expect(indexes(doc, ranges.after)).toEqual([
			[0, 3],
			[13, 13],
		])
		text.insert(0, 'prefix ')
		expect(indexes(doc, ranges.after)).toEqual([
			[7, 10],
			[20, 20],
		])
		expect(agentEditRanges(doc, update)).toEqual({ before: [], after: [] })
	} finally {
		doc.destroy()
		author.destroy()
	}
})

test('agent ranges follow page text and changes to block attributes', () => {
	const id = crypto.randomUUID()
	const taskId = crypto.randomUUID()
	const page = (text: string, checked: boolean) =>
		writeWorkspacePage([
			{ id, kind: 'paragraph', text },
			{ id: taskId, kind: 'task', text: 'Send the notes', checked },
		])
	const doc = createCollaborativeDocument(
		page('Old text', false),
		workspacePageMediaType,
	)
	const author = new Y.Doc()
	try {
		Y.applyUpdate(author, Y.encodeStateAsUpdate(doc))
		replaceCollaborativeContent(
			author,
			workspacePageMediaType,
			page('New text', true),
		)
		const update = Y.encodeStateAsUpdate(author, Y.encodeStateVector(doc))
		const ranges = agentEditRanges(doc, update)
		expect(indexes(doc, ranges.before)).toEqual(
			expect.arrayContaining([
				[0, 3],
				[1, 2],
			]),
		)
		Y.applyUpdate(doc, update)
		expect(indexes(doc, ranges.after)).toEqual(
			expect.arrayContaining([
				[0, 3],
				[1, 2],
			]),
		)
	} finally {
		doc.destroy()
		author.destroy()
	}
})
