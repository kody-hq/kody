import * as Y from 'yjs'
import { byteLength, documentLimits, type DocumentPatch } from './contracts.ts'

export class DocumentFailure extends Error {
	code: string
	status: number
	constructor(code: string, message: string, status = 400) {
		super(message)
		this.code = code
		this.status = status
	}
}

function assertDocumentBounds(doc: Y.Doc) {
	if (Array.from(doc.share.keys()).some((key) => key !== 'content'))
		throw new DocumentFailure(
			'invalid_document',
			'Only document text may change.',
		)
	if (
		byteLength(doc.getText('content').toString()) > documentLimits.contentBytes
	)
		throw new DocumentFailure(
			'content_limit',
			'This document has reached its size limit.',
			413,
		)
	if (Y.encodeStateAsUpdate(doc).byteLength > documentLimits.stateBytes)
		throw new DocumentFailure(
			'state_limit',
			'This document has reached its collaboration state limit.',
			413,
		)
}

/** Apply untrusted changes to a candidate, never mutate the acknowledged state. */
export function candidateDocument(state: Uint8Array, update?: Uint8Array) {
	const doc = new Y.Doc()
	try {
		Y.applyUpdate(doc, state)
		if (update) Y.applyUpdate(doc, update)
		assertDocumentBounds(doc)
		return doc
	} catch (error) {
		doc.destroy()
		if (error instanceof DocumentFailure) throw error
		throw new DocumentFailure(
			'invalid_update',
			'The document update could not be read.',
		)
	}
}

export function applyDocumentPatch(
	doc: Y.Doc,
	version: number,
	patch: DocumentPatch,
) {
	const text = doc.getText('content')
	const current = text.toString()
	if (patch.kind === 'replace') {
		if (patch.baseVersion !== version || patch.base !== current) {
			return {
				ok: false as const,
				code: 'stale_replace',
				version,
				base: patch.base,
				current,
				proposed: patch.content,
			}
		}
		doc.transact(() => {
			text.delete(0, text.length)
			text.insert(0, patch.content)
		})
	} else {
		const index = current.indexOf(patch.quote)
		if (index < 0 || current.indexOf(patch.quote, index + 1) >= 0) {
			return {
				ok: false as const,
				code: index < 0 ? 'anchor_missing' : 'anchor_ambiguous',
				version,
				current,
			}
		}
		doc.transact(() => {
			text.delete(index, patch.quote.length)
			text.insert(index, patch.replacement)
		})
	}
	assertDocumentBounds(doc)
	return { ok: true as const }
}

/** Preserve common text, so a local textarea edit does not replace remote edits. */
export function replaceTextRange(text: Y.Text, next: string) {
	const previous = text.toString()
	let start = 0
	while (
		start < previous.length &&
		start < next.length &&
		previous[start] === next[start]
	)
		start++
	let end = 0
	while (
		end < previous.length - start &&
		end < next.length - start &&
		previous[previous.length - end - 1] === next[next.length - end - 1]
	)
		end++
	text.doc?.transact(() => {
		text.delete(start, previous.length - start - end)
		text.insert(start, next.slice(start, next.length - end))
	})
}
