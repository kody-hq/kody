import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
	createCollaborativeDocument,
	collaborativeContent,
	replaceCollaborativeContent,
} from './collaborative-document.ts'
import {
	workspacePageMediaType as mediaType,
	writeWorkspacePage,
	readWorkspacePage,
} from './workspace-page.ts'
const a = '00000000-0000-4000-8000-000000000001',
	b = '00000000-0000-4000-8000-000000000002'
const content = writeWorkspacePage([
	{ id: a, kind: 'paragraph', text: 'Hello team\nSecond line' },
	{ id: b, kind: 'paragraph', text: 'Ship Friday' },
])
function copy(doc: Y.Doc) {
	const other = new Y.Doc()
	Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
	return other
}
describe('shared workspace document', () => {
	it('round trips page blocks, line breaks, checklists and embeds', () => {
		const doc = createCollaborativeDocument(content, mediaType)
		expect(collaborativeContent(doc, mediaType)).toBe(content)
		replaceCollaborativeContent(
			doc,
			mediaType,
			writeWorkspacePage([
				{ id: a, kind: 'task', checked: true, text: 'Reviewed\nDone' },
				{ id: b, kind: 'file', fileId: a },
			]),
		)
		expect(
			readWorkspacePage(collaborativeContent(doc, mediaType))?.blocks,
		).toEqual([
			{ id: a, kind: 'task', checked: true, text: 'Reviewed\nDone' },
			{ id: b, kind: 'file', fileId: a },
		])
		doc.destroy()
	})
	it('converges simultaneous human and agent edits without replacing unrelated blocks', () => {
		const base = createCollaborativeDocument(content, mediaType),
			human = copy(base),
			agent = copy(base)
		replaceCollaborativeContent(
			human,
			mediaType,
			writeWorkspacePage([
				{ id: a, kind: 'paragraph', text: 'Hello everyone\nSecond line' },
				{ id: b, kind: 'paragraph', text: 'Ship Friday' },
			]),
		)
		replaceCollaborativeContent(
			agent,
			mediaType,
			writeWorkspacePage([
				{ id: a, kind: 'paragraph', text: 'Hello team\nSecond line' },
				{ id: b, kind: 'paragraph', text: 'Ship Monday' },
			]),
		)
		Y.applyUpdate(human, Y.encodeStateAsUpdate(agent))
		Y.applyUpdate(agent, Y.encodeStateAsUpdate(human))
		const value = collaborativeContent(human, mediaType)
		expect(collaborativeContent(agent, mediaType)).toBe(value)
		expect(
			readWorkspacePage(value)?.blocks.map((b) =>
				b.kind === 'file' ? '' : b.text,
			),
		).toEqual(['Hello everyone\nSecond line', 'Ship Monday'])
		;[base, human, agent].forEach((d) => d.destroy())
	})
	it('keeps relative comment anchors attached when an agent inserts text before them', () => {
		const doc = createCollaborativeDocument('Hello team', 'text/plain'),
			text = doc.getText('content')
		const anchor = Y.createRelativePositionFromTypeIndex(text, 6)
		replaceCollaborativeContent(doc, 'text/plain', 'Hello great team')
		expect(
			Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.index,
		).toBe(12)
		doc.destroy()
	})
	it('rejects malformed page structure rather than persisting arbitrary CRDT nodes', () => {
		const doc = createCollaborativeDocument(content, mediaType)
		doc.getXmlFragment('default').insert(0, [new Y.XmlElement('script')])
		expect(() => collaborativeContent(doc, mediaType)).toThrow()
		doc.destroy()
	})
})
