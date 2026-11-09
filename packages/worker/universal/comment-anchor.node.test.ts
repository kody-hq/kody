import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { commentAnchorExists } from './comment-anchor.ts'
import {
	createCollaborativeDocument,
	replaceCollaborativeContent,
} from './collaborative-document.ts'
import { workspacePageMediaType, writeWorkspacePage } from './workspace-page.ts'

test('text anchors follow insertions and become outdated when their entire range is removed', () => {
	const doc = createCollaborativeDocument('Hello team', 'text/plain')
	const text = doc.getText('content')
	const anchor = {
		kind: 'text' as const,
		start: JSON.stringify(Y.createRelativePositionFromTypeIndex(text, 6)),
		end: JSON.stringify(Y.createRelativePositionFromTypeIndex(text, 10)),
		quote: 'team',
		revisionId: crypto.randomUUID(),
	}
	text.insert(0, 'Welcome! ')
	expect(commentAnchorExists(doc, 'text/plain', anchor)).toBe(true)
	text.delete(15, 4)
	expect(commentAnchorExists(doc, 'text/plain', anchor)).toBe(false)
	expect(
		commentAnchorExists(doc, 'text/plain', { ...anchor, start: 'broken' }),
	).toBe(false)
	doc.destroy()
})

test('block anchors retain stable IDs through edits and become outdated on deletion', () => {
	const id = crypto.randomUUID()
	const doc = createCollaborativeDocument(
		writeWorkspacePage([{ id, kind: 'paragraph', text: 'A draft' }]),
		workspacePageMediaType,
	)
	const anchor = { kind: 'block' as const, blockId: id }
	replaceCollaborativeContent(
		doc,
		workspacePageMediaType,
		writeWorkspacePage([{ id, kind: 'heading', text: 'Revised' }]),
	)
	expect(commentAnchorExists(doc, workspacePageMediaType, anchor)).toBe(true)
	replaceCollaborativeContent(
		doc,
		workspacePageMediaType,
		writeWorkspacePage([]),
	)
	expect(commentAnchorExists(doc, workspacePageMediaType, anchor)).toBe(false)
	doc.destroy()
})

test('preview anchors resolve only on the revision and content they describe', () => {
	const revisionId = crypto.randomUUID()
	const json = createCollaborativeDocument(
		'{"a/b":{"~key":[null]}}',
		'application/json',
	)
	const csv = createCollaborativeDocument(
		'Name,Notes\nExample,"one,two"',
		'text/csv',
	)
	const image = { kind: 'image', x: 0.5, y: 0.75, revisionId } as const
	const audio = { kind: 'audio', timeMs: 250, revisionId } as const
	const property = {
		kind: 'json',
		pointer: '/a~1b/~0key/0',
		revisionId,
	} as const
	const cell = { kind: 'csv', row: 1, column: 1, revisionId } as const
	expect(
		commentAnchorExists(json, 'application/json', property, revisionId),
	).toBe(true)
	expect(
		commentAnchorExists(
			json,
			'application/json',
			{ ...property, pointer: '/a~1b/~0key/length' },
			revisionId,
		),
	).toBe(false)
	expect(commentAnchorExists(csv, 'text/csv', cell, revisionId)).toBe(true)
	expect(
		commentAnchorExists(csv, 'text/csv', { ...cell, column: 2 }, revisionId),
	).toBe(false)
	expect(commentAnchorExists(csv, 'text/csv', cell, crypto.randomUUID())).toBe(
		false,
	)
	expect(commentAnchorExists(json, 'image/png', image, revisionId)).toBe(true)
	expect(commentAnchorExists(json, 'audio/wav', audio, revisionId)).toBe(true)
	expect(commentAnchorExists(json, 'image/png', audio, revisionId)).toBe(false)
	json.destroy()
	csv.destroy()
})
