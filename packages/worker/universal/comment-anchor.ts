import { parseCsvPreview } from './csv-preview.ts'
import { fileViewerKind } from './file-viewers.ts'
import * as Y from 'yjs'
import type { CommentAnchor } from './file-collaboration.ts'
import { collaborativeContent } from './collaborative-document.ts'
import { readWorkspacePage, workspacePageMediaType } from './workspace-page.ts'

/** Resolve against shared identities, never against offsets in an old export. */
export function commentAnchorExists(
	doc: Y.Doc,
	mediaType: string,
	anchor: CommentAnchor,
	revisionId?: string,
) {
	if (anchor.kind === 'file') return true
	if (anchor.kind === 'video') return mediaType.startsWith('video/')
	if (
		anchor.kind === 'audio' ||
		anchor.kind === 'image' ||
		anchor.kind === 'json' ||
		anchor.kind === 'csv'
	) {
		if (anchor.revisionId !== revisionId) return false
		if (anchor.kind === 'audio' || anchor.kind === 'image')
			return fileViewerKind('', mediaType) === anchor.kind
		const source = doc.getText('content').toString()
		if (anchor.kind === 'csv')
			return (
				mediaType === 'text/csv' &&
				parseCsvPreview(source)?.[anchor.row]?.[anchor.column] !== undefined
			)
		if (fileViewerKind('', mediaType) !== 'json') return false
		try {
			let value: unknown = JSON.parse(source)
			for (const token of anchor.pointer.split('/').slice(1)) {
				const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
				if (
					value === null ||
					typeof value !== 'object' ||
					!Object.hasOwn(value, key)
				)
					return false
				if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return false
				value = (value as Record<string, unknown>)[key]
			}
			return true
		} catch {
			return false
		}
	}
	if (anchor.kind === 'block' || anchor.blockId) {
		if (mediaType !== workspacePageMediaType) return false
		const page = readWorkspacePage(collaborativeContent(doc, mediaType))
		if (!page?.blocks.some((block) => block.id === anchor.blockId)) return false
		if (anchor.kind === 'block') return true
	}
	try {
		const start = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(JSON.parse(anchor.start)),
			doc,
		)
		const end = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(JSON.parse(anchor.end)),
			doc,
		)
		return (
			!!start && !!end && (start.type !== end.type || start.index !== end.index)
		)
	} catch {
		return false
	}
}
