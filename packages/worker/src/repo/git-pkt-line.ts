/**
 * Git pkt-line helpers for smart HTTP advertisements.
 * isomorphic-git keeps pkt-line internals private; keep a small local encoder.
 */

const flushPkt = '0000'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeGitPktLine(payload: string): string {
	const length = textEncoder.encode(payload).byteLength + 4
	if (length > 0xffff) {
		throw new Error(`Git pkt-line payload too large (${length} bytes).`)
	}
	return `${length.toString(16).padStart(4, '0')}${payload}`
}

export function encodeGitFlushPkt(): string {
	return flushPkt
}

const pktLengthHexPattern = /^[0-9a-fA-F]{4}$/

/**
 * Split a Git pkt-line stream using byte offsets (length fields are bytes, not
 * UTF-8 code units). Fails closed on truncated packets, invalid length hex, or
 * trailing unparsed bytes so callers cannot miss framed content.
 */
export function splitGitPktLines(
	body: Uint8Array,
): { ok: true; packets: Array<string | null> } | { ok: false } {
	const packets: Array<string | null> = []
	let offset = 0
	while (offset + 4 <= body.byteLength) {
		const lengthHex = textDecoder.decode(body.subarray(offset, offset + 4))
		if (lengthHex === flushPkt) {
			packets.push(null)
			offset += 4
			continue
		}
		if (!pktLengthHexPattern.test(lengthHex)) return { ok: false }
		const length = Number.parseInt(lengthHex, 16)
		if (!Number.isFinite(length) || length < 4) return { ok: false }
		if (offset + length > body.byteLength) return { ok: false }
		packets.push(textDecoder.decode(body.subarray(offset + 4, offset + length)))
		offset += length
	}
	if (offset !== body.byteLength) return { ok: false }
	return { ok: true, packets }
}

const requiredUploadPackCapabilities = [
	'allow-tip-sha1-in-want',
	'allow-reachable-sha1-in-want',
] as const

function withRequiredUploadPackCapabilities(capabilities: Array<string>) {
	const seen = new Set(capabilities)
	for (const required of requiredUploadPackCapabilities) {
		if (!seen.has(required)) {
			capabilities.push(required)
			seen.add(required)
		}
	}
	return capabilities
}

/**
 * Build a protocol-v1 `git-upload-pack` advertisement that only exposes one
 * immutable snapshot commit on HEAD and the default branch.
 */
export function buildUploadPackAdvertisement(input: {
	commit: string
	defaultBranch: string
	agent?: string
}): Uint8Array {
	const commit = input.commit.trim().toLowerCase()
	if (!/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error('Published snapshot commit must be a 40-character SHA.')
	}
	const branch = input.defaultBranch.trim() || 'main'
	const headRef = `refs/heads/${branch}`
	const capabilities = withRequiredUploadPackCapabilities([
		'multi_ack',
		'thin-pack',
		'side-band',
		'side-band-64k',
		'ofs-delta',
		'shallow',
		'deepen-since',
		'deepen-not',
		'deepen-relative',
		'no-progress',
		'include-tag',
		'multi_ack_detailed',
		'no-done',
		`symref=HEAD:${headRef}`,
		`agent=${input.agent ?? 'kody'}`,
	]).join(' ')

	const body =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(`${commit} HEAD\0${capabilities}\n`) +
		encodeGitPktLine(`${commit} ${headRef}\n`) +
		encodeGitFlushPkt()

	return textEncoder.encode(body)
}

/**
 * Rewrite an upstream upload-pack advertisement so every advertised ref points
 * at the published snapshot commit, while preserving the upstream capability
 * list from the first ref packet (so later upload-pack negotiation matches).
 * Falls back to a generated advertisement when the upstream body is unusable.
 */
export function rewriteUploadPackAdvertisement(input: {
	upstreamBody: Uint8Array
	commit: string
	defaultBranch: string
	agent?: string
}): Uint8Array {
	const commit = input.commit.trim().toLowerCase()
	if (!/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error('Published snapshot commit must be a 40-character SHA.')
	}
	const branch = input.defaultBranch.trim() || 'main'
	const headRef = `refs/heads/${branch}`
	const parsed = splitGitPktLines(input.upstreamBody)
	if (!parsed.ok) {
		return buildUploadPackAdvertisement(input)
	}
	let capabilities: string | null = null
	for (const packet of parsed.packets) {
		if (packet === null) continue
		if (packet.startsWith('# service=')) continue
		const nullIndex = packet.indexOf('\0')
		if (nullIndex === -1) continue
		const rest = packet.slice(nullIndex + 1).replace(/\n$/, '')
		if (rest.length > 0) {
			capabilities = withRequiredUploadPackCapabilities(
				rest
					.split(' ')
					.filter(
						(part) =>
							part.length > 0 &&
							!part.startsWith('symref=') &&
							!part.startsWith('agent='),
					)
					.concat([`symref=HEAD:${headRef}`, `agent=${input.agent ?? 'kody'}`]),
			).join(' ')
			break
		}
	}
	if (!capabilities) {
		return buildUploadPackAdvertisement(input)
	}

	const body =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(`${commit} HEAD\0${capabilities}\n`) +
		encodeGitPktLine(`${commit} ${headRef}\n`) +
		encodeGitFlushPkt()
	return textEncoder.encode(body)
}

/**
 * Extract `want <oid>` object ids from a protocol-v1 upload-pack request body.
 * Ignores have/shallow/deepen/done and capability suffixes on the first want.
 * Fails closed when the pkt-line framing cannot be fully parsed, or when a
 * `want` line is present but does not carry a 40-hex oid (so Artifacts cannot
 * honor a framed want that this filter missed).
 */
export function extractUploadPackWantOids(
	body: Uint8Array,
): { ok: true; wants: Array<string> } | { ok: false } {
	const parsed = splitGitPktLines(body)
	if (!parsed.ok) return { ok: false }
	const wants: Array<string> = []
	for (const packet of parsed.packets) {
		if (packet === null) continue
		const line = packet.replace(/\n$/, '')
		if (!line.startsWith('want ')) continue
		const oid = line.slice('want '.length).split(' ', 1)[0]?.toLowerCase()
		if (!oid || !/^[0-9a-f]{40}$/.test(oid)) return { ok: false }
		wants.push(oid)
	}
	return { ok: true, wants }
}

/**
 * True only when the body fully parses and every `want` targets the published
 * snapshot. Empty-want or unparseable bodies fail closed so a crafted packet
 * cannot hide unpublished wants from this filter while Artifacts still honors
 * them with the minted read token.
 */
export function uploadPackWantsOnlySnapshot(input: {
	body: Uint8Array
	snapshotCommit: string
}) {
	const snapshot = input.snapshotCommit.trim().toLowerCase()
	const extracted = extractUploadPackWantOids(input.body)
	if (!extracted.ok) return false
	if (extracted.wants.length === 0) return false
	return extracted.wants.every((oid) => oid === snapshot)
}

export type UploadPackAckMode = 'detailed' | 'multi' | 'single'

export type UploadPackRequestSummary = {
	ackMode: UploadPackAckMode
	hasDone: boolean
	hasHaves: boolean
}

function stripPktNewline(packet: string) {
	return packet.endsWith('\n') ? packet.slice(0, -1) : packet
}

/**
 * Read ack mode from the capability list on the first `want` line.
 * Unparseable bodies are reported as single-ack so callers pass the upstream
 * response through unchanged instead of rewriting bytes they could not frame.
 */
export function summarizeUploadPackRequest(
	body: Uint8Array,
): UploadPackRequestSummary {
	const parsed = splitGitPktLines(body)
	if (!parsed.ok) {
		return { ackMode: 'single', hasDone: false, hasHaves: false }
	}
	let ackMode: UploadPackAckMode = 'single'
	let hasDone = false
	let hasHaves = false
	let sawWant = false
	for (const packet of parsed.packets) {
		if (packet === null) continue
		const line = stripPktNewline(packet)
		if (!sawWant && line.startsWith('want ')) {
			sawWant = true
			const capabilities = line.split(' ').slice(2)
			if (capabilities.includes('multi_ack_detailed')) ackMode = 'detailed'
			else if (capabilities.includes('multi_ack')) ackMode = 'multi'
		} else if (line === 'done') {
			hasDone = true
		} else if (line.startsWith('have ')) {
			hasHaves = true
		}
	}
	return { ackMode, hasDone, hasHaves }
}

const plainAckPattern = /^ACK ([0-9a-fA-F]{40})$/

function isAckOrNakPacket(packet: string) {
	const line = stripPktNewline(packet)
	return line === 'NAK' || line.startsWith('ACK ')
}

function negotiationStatusForAckMode(ackMode: 'detailed' | 'multi') {
	switch (ackMode) {
		case 'detailed':
			return 'common'
		case 'multi':
			return 'continue'
		default: {
			const exhaustive: never = ackMode
			throw new Error(`Unexpected upload-pack ack mode: ${String(exhaustive)}`)
		}
	}
}

/**
 * Rewrite a multi-ack negotiation response that omitted ack statuses.
 * Plain `ACK <oid>` becomes `ACK <oid> common` (detailed) or `continue`
 * (multi). Lines that already carry a status are left alone. The result ends
 * with `NAK` and nothing after it. Side-band or other non-ack bodies, and
 * bodies that do not split into pkt-lines, are returned unchanged so a
 * compliant upload-pack (which may already be sending the pack) is not
 * rewritten. Never emits `ready`.
 */
export function normalizeUploadPackNegotiationResponse(input: {
	body: Uint8Array
	ackMode: UploadPackAckMode
}): Uint8Array {
	if (input.ackMode === 'single') return input.body
	const parsed = splitGitPktLines(input.body)
	if (!parsed.ok) return input.body
	for (const packet of parsed.packets) {
		if (packet === null) continue
		if (!isAckOrNakPacket(packet)) return input.body
	}

	const status = negotiationStatusForAckMode(input.ackMode)
	const packets: Array<string | null> = []
	for (const packet of parsed.packets) {
		if (packet === null) {
			packets.push(null)
			continue
		}
		const plain = plainAckPattern.exec(stripPktNewline(packet))
		if (plain?.[1]) {
			packets.push(`ACK ${plain[1]} ${status}\n`)
			continue
		}
		packets.push(packet.endsWith('\n') ? packet : `${packet}\n`)
	}

	while (packets.length > 0 && packets[packets.length - 1] === null) {
		packets.pop()
	}
	const last = packets[packets.length - 1]
	const lastLine = typeof last === 'string' ? stripPktNewline(last) : null
	if (lastLine !== 'NAK') packets.push('NAK\n')

	let encoded = ''
	for (const packet of packets) {
		encoded += packet === null ? encodeGitFlushPkt() : encodeGitPktLine(packet)
	}
	return textEncoder.encode(encoded)
}
