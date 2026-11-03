import { maxPlanEmailLimits } from '#universal/plans.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import type { EmailAttachmentMetadata } from './types.ts'

/** Cloudflare Email Routing inbound hard cap. */
export const maxSurvivableInboundRawBytes = 25 * 1024 * 1024

/**
 * Maximum raw MIME we persist. Same bound as paid/max
 * `email_message_bytes`. Larger inbound mail is reduced to this size.
 */
export const maxKeptInboundRawBytes = maxPlanEmailLimits.email_message_bytes

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const crlf = textEncoder.encode('\r\n')
const crlfCrlf = textEncoder.encode('\r\n\r\n')
const lfLf = textEncoder.encode('\n\n')
/** Space reserved so X-Kody reduction headers cannot blow the persist cap. */
const reductionHeaderReserveBytes = 256

export type PreparedInboundRawMime = {
	rawMime: string
	keptRawSize: number
	originalRawSize: number
	originalSha256: string | null
	reduced: boolean
	omittedAttachments: Array<EmailAttachmentMetadata>
}

type MimeLeaf = {
	kind: 'leaf'
	headers: string
	contentType: string
	filename: string | null
	contentId: string | null
	disposition: string | null
	body: Uint8Array
}

type MimeMultipart = {
	kind: 'multipart'
	headers: string
	contentType: string
	boundary: string
	children: Array<MimeNode>
}

type MimeNode = MimeLeaf | MimeMultipart

export async function prepareInboundRawMime(
	raw: Uint8Array,
	options: { maxKeptBytes?: number } = {},
): Promise<PreparedInboundRawMime> {
	const maxKeptBytes = options.maxKeptBytes ?? maxKeptInboundRawBytes
	const originalRawSize = raw.byteLength
	if (originalRawSize <= maxKeptBytes) {
		return {
			rawMime: textDecoder.decode(raw),
			keptRawSize: originalRawSize,
			originalRawSize,
			originalSha256: null,
			reduced: false,
			omittedAttachments: [],
		}
	}
	const digestInput = new Uint8Array(raw.byteLength)
	digestInput.set(raw)
	const originalSha256 = toHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput)),
	)
	const omittedAttachments: Array<EmailAttachmentMetadata> = []
	const root = parseMimeNode(raw) ?? fallbackLeaf(raw)
	const rebuilt = keepTextOnly(
		root,
		Math.max(maxKeptBytes - reductionHeaderReserveBytes, 0),
		omittedAttachments,
	)
	const notice = omissionNotice(omittedAttachments)
	const withNotice = notice
		? ensureOmissionNotice(
				rebuilt,
				notice,
				Math.max(maxKeptBytes - reductionHeaderReserveBytes, 0),
			)
		: rebuilt
	const reducedHeaders = appendReductionHeaders(withNotice.headers, {
		originalRawSize,
		originalSha256,
	})
	let rawMime = serializeNode({ ...withNotice, headers: reducedHeaders })
	if (utf8ByteLength(rawMime) > maxKeptBytes) {
		rawMime = serializeGuaranteedPlainMessage({
			headers: root.headers,
			omittedAttachments,
			originalRawSize,
			originalSha256,
			maxKeptBytes,
		})
	}
	return {
		rawMime,
		keptRawSize: utf8ByteLength(rawMime),
		originalRawSize,
		originalSha256,
		reduced: true,
		omittedAttachments,
	}
}

function parseMimeNode(raw: Uint8Array): MimeNode | null {
	const split = splitHeadersAndBody(raw)
	if (!split) return null
	const contentTypeHeader = getMimeHeader(split.headers, 'content-type')
	const parsedType = parseContentType(contentTypeHeader)
	if (parsedType.mime.startsWith('multipart/') && parsedType.boundary) {
		const children: Array<MimeNode> = []
		for (const part of splitMultipartParts(split.body, parsedType.boundary)) {
			const child = parseMimeNode(part)
			if (child) children.push(child)
		}
		if (children.length === 0) return null
		return {
			kind: 'multipart',
			headers: split.headers,
			contentType: parsedType.mime,
			boundary: parsedType.boundary,
			children,
		}
	}
	return {
		kind: 'leaf',
		headers: split.headers,
		contentType: parsedType.mime || 'application/octet-stream',
		filename: partFilename(split.headers, parsedType.name),
		contentId: getMimeHeader(split.headers, 'content-id'),
		disposition: parseDisposition(split.headers),
		body: split.body,
	}
}

function fallbackLeaf(raw: Uint8Array): MimeLeaf {
	const split = splitHeadersAndBody(raw)
	const headers = split?.headers ?? 'MIME-Version: 1.0'
	const body = split?.body ?? raw
	return {
		kind: 'leaf',
		headers,
		contentType: 'application/octet-stream',
		filename: partFilename(headers, null),
		contentId: getMimeHeader(headers, 'content-id'),
		disposition: parseDisposition(headers),
		body,
	}
}

function keepTextOnly(
	node: MimeNode,
	budget: number,
	omitted: Array<EmailAttachmentMetadata>,
): MimeNode {
	if (node.kind === 'leaf') {
		if (isTextPart(node)) {
			const kept = keepTextLeaf(node, budget)
			if (kept) return kept
			return textMessageLeaf(node.headers, fallbackOmissionBody(omitted))
		}
		omitLeaf(node, omitted)
		return textMessageLeaf(node.headers, fallbackOmissionBody(omitted))
	}
	const headerCost = utf8ByteLength(`${node.headers}\r\n\r\n`)
	const closeCost = utf8ByteLength(`\r\n--${node.boundary}--\r\n`)
	let remaining = Math.max(budget - headerCost - closeCost, 0)
	const keptChildren: Array<MimeNode> = []
	for (const child of node.children) {
		if (child.kind === 'leaf' && !isTextPart(child)) {
			omitLeaf(child, omitted)
			continue
		}
		const delimiterCost = utf8ByteLength(`\r\n--${node.boundary}\r\n`)
		const childBudget = Math.max(remaining - delimiterCost, 0)
		const rebuilt =
			child.kind === 'leaf'
				? keepTextLeaf(child, childBudget)
				: keepTextOnly(child, childBudget, omitted)
		if (!rebuilt) continue
		const used = utf8ByteLength(serializeNode(rebuilt))
		if (used + delimiterCost > remaining) {
			const fallback = textMessageLeaf(
				child.kind === 'leaf' ? child.headers : node.headers,
				fallbackOmissionBody(omitted),
			)
			const fallbackUsed = utf8ByteLength(serializeNode(fallback))
			if (fallbackUsed + delimiterCost <= remaining) {
				keptChildren.push(fallback)
				remaining -= fallbackUsed + delimiterCost
			}
			continue
		}
		keptChildren.push(rebuilt)
		remaining -= used + delimiterCost
	}
	if (keptChildren.length === 0) {
		return textMessageLeaf(node.headers, fallbackOmissionBody(omitted))
	}
	return {
		...node,
		children: keptChildren,
	}
}

function keepTextLeaf(node: MimeLeaf, budget: number): MimeLeaf | null {
	const cte = contentTransferEncoding(node.headers)
	if (cte !== '7bit' && cte !== '8bit') return null
	if (utf8ByteLength(serializeNode(node)) <= budget) return node
	const notice = '\n[truncated]'
	const rewritten = rewrittenUtf8TextLeaf(node, notice)
	const headerCost = utf8ByteLength(`${rewritten.headers}\r\n\r\n`)
	const bodyBudget = Math.max(budget - headerCost - utf8ByteLength(notice), 0)
	const truncated = rewrittenUtf8TextLeaf(
		node,
		`${truncateToUtf8Bytes(textDecoder.decode(node.body), bodyBudget)}${notice}`,
	)
	if (utf8ByteLength(serializeNode(truncated)) <= budget) return truncated
	return null
}

function rewrittenUtf8TextLeaf(node: MimeLeaf, body: string): MimeLeaf {
	return {
		...node,
		headers: replaceHeader(
			replaceHeader(node.headers, 'content-transfer-encoding', '8bit'),
			'content-type',
			node.contentType.includes('html')
				? 'text/html; charset=utf-8'
				: 'text/plain; charset=utf-8',
		),
		body: textEncoder.encode(body),
	}
}

function contentTransferEncoding(headers: string) {
	return (
		getMimeHeader(headers, 'content-transfer-encoding') ?? '7bit'
	).toLowerCase()
}

function omitLeaf(node: MimeLeaf, omitted: Array<EmailAttachmentMetadata>) {
	omitted.push({
		filename: node.filename,
		contentType: node.contentType,
		contentId: node.contentId,
		disposition: node.disposition,
		size: node.body.byteLength,
		storageKind: 'unavailable',
	})
}

function isTextPart(node: MimeNode) {
	if (node.kind !== 'leaf') return false
	return (
		node.contentType.startsWith('text/plain') ||
		node.contentType.startsWith('text/html')
	)
}

function textMessageLeaf(headers: string, body: string): MimeLeaf {
	return {
		kind: 'leaf',
		headers: replaceHeader(
			replaceHeader(
				stripDeliveryHeaders(headers),
				'content-type',
				'text/plain; charset=utf-8',
			),
			'content-transfer-encoding',
			'8bit',
		),
		contentType: 'text/plain',
		filename: null,
		contentId: null,
		disposition: null,
		body: textEncoder.encode(body),
	}
}

function fallbackOmissionBody(omitted: Array<EmailAttachmentMetadata>) {
	return omissionNotice(omitted) ?? '[Kody omitted oversized content]'
}

function serializeGuaranteedPlainMessage(input: {
	headers: string
	omittedAttachments: Array<EmailAttachmentMetadata>
	originalRawSize: number
	originalSha256: string
	maxKeptBytes: number
}) {
	const leaf = textMessageLeaf(
		input.headers,
		fallbackOmissionBody(input.omittedAttachments),
	)
	const headers = appendReductionHeaders(leaf.headers, {
		originalRawSize: input.originalRawSize,
		originalSha256: input.originalSha256,
	})
	const headerCost = utf8ByteLength(`${headers}\r\n\r\n`)
	const bodyBudget = Math.max(input.maxKeptBytes - headerCost, 0)
	const body = truncateToUtf8Bytes(textDecoder.decode(leaf.body), bodyBudget)
	return `${normalizeHeaderBlock(headers)}\r\n\r\n${body}`
}

function ensureOmissionNotice(
	node: MimeNode,
	notice: string,
	budget: number,
): MimeNode {
	if (node.kind === 'leaf') {
		if (!isTextPart(node)) return node
		const combined = textEncoder.encode(
			`${textDecoder.decode(node.body)}\n${notice}`,
		)
		if (utf8ByteLength(node.headers) + combined.byteLength < budget) {
			return { ...node, body: combined }
		}
		return node
	}
	const noticeLeaf: MimeLeaf = {
		kind: 'leaf',
		headers:
			'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit',
		contentType: 'text/plain',
		filename: null,
		contentId: null,
		disposition: null,
		body: textEncoder.encode(notice),
	}
	const extra = utf8ByteLength(serializeNode(noticeLeaf))
	if (utf8ByteLength(serializeNode(node)) + extra > budget) return node
	return { ...node, children: [...node.children, noticeLeaf] }
}

function omissionNotice(omitted: Array<EmailAttachmentMetadata>) {
	if (omitted.length === 0) return null
	const items = omitted.map((part) => {
		const name = part.filename ?? part.contentType
		return `${name} (${formatByteCount(part.size)})`
	})
	if (items.length === 1) {
		return `[Kody omitted an oversized attachment: ${items[0]}]`
	}
	return `[Kody omitted ${items.length} oversized attachments: ${items.join(', ')}]`
}

function formatByteCount(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function serializeNode(node: MimeNode): string {
	if (node.kind === 'leaf') {
		return `${normalizeHeaderBlock(node.headers)}\r\n\r\n${textDecoder.decode(node.body)}`
	}
	const parts = node.children.map((child) => serializeNode(child))
	return `${normalizeHeaderBlock(node.headers)}\r\n\r\n${parts
		.map((part) => `--${node.boundary}\r\n${part}`)
		.join('\r\n')}\r\n--${node.boundary}--\r\n`
}

function normalizeHeaderBlock(headers: string) {
	return headers.replace(/\s+$/u, '')
}

function appendReductionHeaders(
	headers: string,
	input: { originalRawSize: number; originalSha256: string },
) {
	return `${normalizeHeaderBlock(headers)}\r\nX-Kody-Inbound-Reduced: 1\r\nX-Kody-Original-Size: ${input.originalRawSize}\r\nX-Kody-Original-Sha256: ${input.originalSha256}`
}

function splitHeadersAndBody(raw: Uint8Array) {
	const crlfIndex = indexOfBytes(raw, crlfCrlf)
	const lfIndex = indexOfBytes(raw, lfLf)
	let headerEnd = -1
	let separatorLength = 0
	if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex <= lfIndex)) {
		headerEnd = crlfIndex
		separatorLength = crlfCrlf.byteLength
	} else if (lfIndex >= 0) {
		headerEnd = lfIndex
		separatorLength = lfLf.byteLength
	}
	if (headerEnd < 0) return null
	return {
		headers: textDecoder.decode(raw.subarray(0, headerEnd)),
		body: raw.subarray(headerEnd + separatorLength),
	}
}

function splitMultipartParts(body: Uint8Array, boundary: string) {
	const delim = textEncoder.encode(`--${boundary}`)
	const starts: Array<number> = []
	if (startsWith(body, delim)) starts.push(0)
	let cursor = 0
	while (cursor < body.byteLength) {
		const crlfAt = indexOfBytes(body, concatBytes(crlf, delim), cursor)
		const lfAt = indexOfBytes(
			body,
			concatBytes(textEncoder.encode('\n'), delim),
			cursor,
		)
		const next = nearestIndex(crlfAt, lfAt)
		if (next < 0) break
		const delimAt = next === crlfAt ? next + crlf.byteLength : next + 1
		starts.push(delimAt)
		cursor = delimAt + delim.byteLength
	}
	const parts: Array<Uint8Array> = []
	for (let index = 0; index < starts.length; index += 1) {
		const delimStart = starts[index]!
		const afterDelim = delimStart + delim.byteLength
		if (body[afterDelim] === 45 && body[afterDelim + 1] === 45) break
		let contentStart = afterDelim
		if (body[contentStart] === 13 && body[contentStart + 1] === 10) {
			contentStart += 2
		} else if (body[contentStart] === 10) {
			contentStart += 1
		}
		const nextDelim = starts[index + 1]
		let contentEnd = nextDelim ?? body.byteLength
		if (nextDelim != null) {
			if (
				nextDelim >= 2 &&
				body[nextDelim - 2] === 13 &&
				body[nextDelim - 1] === 10
			) {
				contentEnd = nextDelim - 2
			} else if (nextDelim >= 1 && body[nextDelim - 1] === 10) {
				contentEnd = nextDelim - 1
			}
		}
		if (contentEnd > contentStart) {
			parts.push(body.subarray(contentStart, contentEnd))
		}
	}
	return parts
}

function getMimeHeader(headers: string, name: string) {
	const unfolded = headers.replace(/\r?\n[ \t]+/gu, ' ')
	const pattern = new RegExp(`^${escapeRegExp(name)}:\\s*(.*)$`, 'im')
	const match = unfolded.match(pattern)
	return match?.[1]?.trim() || null
}

function parseContentType(value: string | null) {
	if (!value) {
		return { mime: 'application/octet-stream', boundary: null, name: null }
	}
	const [mimeRaw, ...paramTokens] = splitMimeParameters(value)
	const mime = (mimeRaw ?? 'application/octet-stream').trim().toLowerCase()
	const params = Object.fromEntries(
		paramTokens.map((token) => {
			const separator = token.indexOf('=')
			if (separator < 0) return [token.trim().toLowerCase(), '']
			return [
				token.slice(0, separator).trim().toLowerCase(),
				unquoteMimeToken(token.slice(separator + 1).trim()),
			]
		}),
	)
	return {
		mime,
		boundary: params['boundary'] || null,
		name: params['name'] || null,
	}
}

function parseDisposition(headers: string) {
	const value = getMimeHeader(headers, 'content-disposition')
	if (!value) return null
	return value.split(';')[0]?.trim().toLowerCase() || null
}

function partFilename(headers: string, typeName: string | null) {
	const disposition = getMimeHeader(headers, 'content-disposition')
	if (disposition) {
		for (const token of splitMimeParameters(disposition).slice(1)) {
			const separator = token.indexOf('=')
			if (separator < 0) continue
			const key = token.slice(0, separator).trim().toLowerCase()
			if (key === 'filename' || key === 'filename*') {
				return unquoteMimeToken(token.slice(separator + 1).trim()) || null
			}
		}
	}
	return typeName
}

function splitMimeParameters(value: string) {
	const tokens: Array<string> = []
	let current = ''
	let quoted = false
	for (const character of value) {
		if (character === '"') {
			quoted = !quoted
			current += character
			continue
		}
		if (character === ';' && !quoted) {
			if (current.trim()) tokens.push(current.trim())
			current = ''
			continue
		}
		current += character
	}
	if (current.trim()) tokens.push(current.trim())
	return tokens
}

function unquoteMimeToken(value: string) {
	const trimmed = value.trim()
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

function replaceHeader(headers: string, name: string, value: string) {
	const pattern = new RegExp(
		`^${escapeRegExp(name)}:.*(?:\\r?\\n[ \\t].*)*`,
		'im',
	)
	if (pattern.test(headers)) {
		return headers.replace(pattern, `${name}: ${value}`)
	}
	return `${normalizeHeaderBlock(headers)}\r\n${name}: ${value}`
}

function stripDeliveryHeaders(headers: string) {
	return headers
		.split(/\r?\n/u)
		.filter((line) => {
			const key = line.split(':')[0]?.trim().toLowerCase()
			return (
				key !== 'content-type' &&
				key !== 'content-transfer-encoding' &&
				key !== 'content-disposition' &&
				key !== 'content-id'
			)
		})
		.join('\r\n')
}

function utf8ByteLength(value: string) {
	return textEncoder.encode(value).byteLength
}

function truncateToUtf8Bytes(value: string, maxBytes: number) {
	const encoded = textEncoder.encode(value)
	if (encoded.byteLength <= maxBytes) return value
	let end = maxBytes
	while (end > 0) {
		const byte = encoded[end]
		if (byte === undefined || (byte & 0xc0) !== 0x80) break
		end -= 1
	}
	return textDecoder.decode(encoded.subarray(0, end))
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0) {
	if (needle.byteLength === 0) return start
	outer: for (
		let index = start;
		index <= haystack.byteLength - needle.byteLength;
		index += 1
	) {
		for (let offset = 0; offset < needle.byteLength; offset += 1) {
			if (haystack[index + offset] !== needle[offset]) continue outer
		}
		return index
	}
	return -1
}

function startsWith(haystack: Uint8Array, needle: Uint8Array) {
	if (haystack.byteLength < needle.byteLength) return false
	for (let index = 0; index < needle.byteLength; index += 1) {
		if (haystack[index] !== needle[index]) return false
	}
	return true
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
	const out = new Uint8Array(left.byteLength + right.byteLength)
	out.set(left)
	out.set(right, left.byteLength)
	return out
}

function nearestIndex(left: number, right: number) {
	if (left < 0) return right
	if (right < 0) return left
	return Math.min(left, right)
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
