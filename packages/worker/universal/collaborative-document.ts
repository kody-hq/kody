import * as Y from 'yjs'
import { Schema } from '@tiptap/pm/model'
import {
	prosemirrorJSONToYDoc,
	yDocToProsemirrorJSON,
	updateYFragment,
} from 'y-prosemirror'
import {
	readWorkspacePage,
	writeWorkspacePage,
	workspacePageMediaType,
} from './workspace-page.ts'

import {
	blocksToDocument,
	documentToBlocks,
	workspaceContentsNode,
	workspaceTableNodes,
	workspaceTextAttributes,
} from './workspace-page-document.ts'

const schema = new Schema({
	nodes: {
		doc: { content: 'block*' },
		text: { group: 'inline' },
		hardBreak: { inline: true, group: 'inline' },
		workspaceText: {
			group: 'block',
			content: 'inline*',
			attrs: workspaceTextAttributes,
		},
		...workspaceTableNodes,
		workspaceContents: workspaceContentsNode,
		workspaceFile: {
			group: 'block',
			atom: true,
			attrs: { id: { default: null }, fileId: { default: null } },
		},
	},
})
export function createCollaborativeDocument(
	content: string,
	mediaType: string,
) {
	if (mediaType !== workspacePageMediaType) {
		const doc = new Y.Doc()
		doc.getText('content').insert(0, content)
		return doc
	}
	const page = readWorkspacePage(content)
	if (!page) throw new Error('Invalid workspace page.')
	return prosemirrorJSONToYDoc(schema, blocksToDocument(page.blocks), 'default')
}
export function collaborativeContent(doc: Y.Doc, mediaType: string) {
	if (mediaType !== workspacePageMediaType)
		return doc.getText('content').toString()
	const json = yDocToProsemirrorJSON(doc, 'default')
	const parsed = schema.nodeFromJSON(json)
	const content = writeWorkspacePage(documentToBlocks(parsed))
	if (!readWorkspacePage(content))
		throw new Error('Invalid shared page structure.')
	return content
}
/** Change the smallest text range so concurrent insertions retain their identities. */
export function replaceCollaborativeText(text: Y.Text, value: string) {
	const previous = text.toString()
	let start = 0,
		end = 0
	while (
		start < previous.length &&
		start < value.length &&
		previous[start] === value[start]
	)
		start++
	while (
		end < previous.length - start &&
		end < value.length - start &&
		previous[previous.length - 1 - end] === value[value.length - 1 - end]
	)
		end++
	const remove = previous.length - start - end
	if (remove) text.delete(start, remove)
	const added = value.slice(start, value.length - end)
	if (added) text.insert(start, added)
}
/** Server-side agent edits operate on existing shared nodes, retaining anchor identities. */
export function replaceCollaborativeContent(
	doc: Y.Doc,
	mediaType: string,
	content: string,
) {
	if (mediaType !== workspacePageMediaType) {
		doc.transact(() =>
			replaceCollaborativeText(doc.getText('content'), content),
		)
		return
	}
	const page = readWorkspacePage(content)
	if (!page) throw new Error('Invalid workspace page.')
	const replacement = createCollaborativeDocument(content, mediaType)
	try {
		const node = schema.nodeFromJSON(
			yDocToProsemirrorJSON(replacement, 'default'),
		)
		updateYFragment(doc, doc.getXmlFragment('default'), node, {
			mapping: new Map(),
			isOMark: new Map(),
		})
	} finally {
		replacement.destroy()
	}
}
