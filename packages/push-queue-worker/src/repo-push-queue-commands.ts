/**
 * Parse receive-pack command pkt-lines and build / read report-status for the
 * push queue's landed-ref cache. Kept small and dependency-free so the DO can
 * reject already-stale pushes without an Artifacts round trip.
 */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** SHA-1 (40) or SHA-256 (64) hex object ids, including the all-zero delete/create oid. */
const oidPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

export type ReceivePackCommand = {
	oldOid: string
	newOid: string
	ref: string
}

export type ParsedReceivePackCommands = {
	commands: Array<ReceivePackCommand>
	/** True when the first command advertised side-band or side-band-64k. */
	sideband: boolean
}

/**
 * How far into a pack we read looking for the command flush. Command sections
 * are tiny; anything past this is treated as unparseable and falls through.
 */
export const receivePackCommandPrefixLimitBytes = 64 * 1024

export function isZeroOid(oid: string) {
	return /^0+$/i.test(oid)
}

export function encodeGitPktLineBytes(
	payload: string | Uint8Array,
): Uint8Array {
	const body =
		typeof payload === 'string' ? textEncoder.encode(payload) : payload
	const length = body.byteLength + 4
	if (length > 0xffff) {
		throw new Error(`Git pkt-line payload too large (${length} bytes).`)
	}
	const header = textEncoder.encode(length.toString(16).padStart(4, '0'))
	const packet = new Uint8Array(header.byteLength + body.byteLength)
	packet.set(header)
	packet.set(body, header.byteLength)
	return packet
}

export function encodeGitFlushPktBytes(): Uint8Array {
	return textEncoder.encode('0000')
}

function encodeSidebandPkt(band: number, payload: Uint8Array): Uint8Array {
	const framed = new Uint8Array(1 + payload.byteLength)
	framed[0] = band
	framed.set(payload, 1)
	return encodeGitPktLineBytes(framed)
}

function parseHexLength(bytes: Uint8Array, offset: number) {
	let value = 0
	for (let i = 0; i < 4; i += 1) {
		const code = bytes[offset + i]!
		const digit =
			code >= 0x30 && code <= 0x39
				? code - 0x30
				: code >= 0x61 && code <= 0x66
					? code - 0x57
					: code >= 0x41 && code <= 0x46
						? code - 0x37
						: -1
		if (digit < 0) return null
		value = value * 16 + digit
	}
	return value
}

function concatBytes(parts: Array<Uint8Array>) {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
	const merged = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		merged.set(part, offset)
		offset += part.byteLength
	}
	return merged
}

/**
 * Parse `old-oid SP new-oid SP ref` command lines from the head of a
 * receive-pack request body (before the pack stream). Returns null when the
 * framing is incomplete or invalid so callers fall through to a normal send.
 */
export function parseReceivePackCommands(
	body: Uint8Array,
): ParsedReceivePackCommands | null {
	const commands: Array<ReceivePackCommand> = []
	let sideband = false
	let offset = 0
	let sawFlush = false
	while (offset + 4 <= body.byteLength) {
		const length = parseHexLength(body, offset)
		if (length === null) return null
		if (length === 0) {
			sawFlush = true
			offset += 4
			break
		}
		if (length < 4) return null
		if (offset + length > body.byteLength) return null
		let text = textDecoder.decode(body.subarray(offset + 4, offset + length))
		offset += length
		const nul = text.indexOf('\0')
		if (nul !== -1) {
			const caps = text
				.slice(nul + 1)
				.replace(/\n$/, '')
				.toLowerCase()
			sideband = caps
				.split(/\s+/)
				.some((cap) => cap === 'side-band' || cap === 'side-band-64k')
			text = text.slice(0, nul)
		}
		text = text.replace(/\n$/, '')
		const parts = text.split(' ')
		if (parts.length < 3) return null
		const oldOid = parts[0]!
		const newOid = parts[1]!
		const ref = parts.slice(2).join(' ')
		if (!oidPattern.test(oldOid) || !oidPattern.test(newOid) || !ref) {
			return null
		}
		commands.push({
			oldOid: oldOid.toLowerCase(),
			newOid: newOid.toLowerCase(),
			ref,
		})
	}
	if (!sawFlush || commands.length === 0) return null
	return { commands, sideband }
}

/**
 * True when every command's old-oid disagrees with a known landed tip for that
 * ref. Cache misses are not stale: those must fall through to Artifacts.
 */
export function allReceivePackCommandsKnownStale(
	commands: ReadonlyArray<ReceivePackCommand>,
	landedRefs: ReadonlyMap<string, string>,
) {
	if (commands.length === 0) return false
	return commands.every((command) => {
		const tip = landedRefs.get(command.ref)
		return tip !== undefined && tip !== command.oldOid
	})
}

/** Build a report-status body that rejects every command with `fetch first`. */
export function buildStaleFetchFirstReportStatus(
	commands: ReadonlyArray<ReceivePackCommand>,
	options: { sideband: boolean } = { sideband: false },
): Uint8Array {
	const statusParts: Array<Uint8Array> = [encodeGitPktLineBytes('unpack ok\n')]
	for (const command of commands) {
		statusParts.push(encodeGitPktLineBytes(`ng ${command.ref} fetch first\n`))
	}
	statusParts.push(encodeGitFlushPktBytes())
	const status = concatBytes(statusParts)
	if (!options.sideband) return status
	// side-band-64k: keep well under 65520 payload bytes per packet.
	const maxPayload = 65515
	const packets: Array<Uint8Array> = []
	for (let offset = 0; offset < status.byteLength; offset += maxPayload) {
		packets.push(
			encodeSidebandPkt(1, status.subarray(offset, offset + maxPayload)),
		)
	}
	packets.push(encodeGitFlushPktBytes())
	return concatBytes(packets)
}

/**
 * Collect refs that report-status marked `ok`. Understands plain and
 * sideband-wrapped (band 1) result bodies. Progress (band 2) is skipped;
 * fatals (band 3) end the scan.
 */
export function collectReportStatusOkRefs(body: Uint8Array): Set<string> {
	const okRefs = new Set<string>()
	scanReportStatusPackets(body, (line) => {
		if (!line.startsWith('ok ')) return
		const ref = line.slice(3).replace(/\n$/, '')
		if (ref) okRefs.add(ref)
	})
	return okRefs
}

function scanReportStatusPackets(
	body: Uint8Array,
	onLine: (line: string) => void,
) {
	let offset = 0
	while (offset + 4 <= body.byteLength) {
		const length = parseHexLength(body, offset)
		if (length === null) return
		if (length < 4) return
		if (offset + length > body.byteLength) return
		const payload = body.subarray(offset + 4, offset + length)
		offset += length
		if (payload.byteLength === 0) continue
		const band = payload[0]!
		// Heuristic: sideband payloads start with band 1/2/3 and the rest is
		// nested pkt-lines (or progress text). Plain report-status lines start
		// with ASCII letters (`unpack` / `ok` / `ng`).
		if (band === 1 || band === 2 || band === 3) {
			if (band === 2) continue
			if (band === 3) return
			scanReportStatusPackets(payload.subarray(1), onLine)
			continue
		}
		onLine(textDecoder.decode(payload))
	}
}

/** Apply successful `ok <ref>` lines onto the landed-ref tip cache. */
export function applyReportStatusOkToLandedRefs(
	landedRefs: Map<string, string>,
	commands: ReadonlyArray<ReceivePackCommand>,
	reportStatusBody: Uint8Array,
) {
	const okRefs = collectReportStatusOkRefs(reportStatusBody)
	if (okRefs.size === 0) return
	for (const command of commands) {
		if (!okRefs.has(command.ref)) continue
		if (isZeroOid(command.newOid)) {
			landedRefs.delete(command.ref)
		} else {
			landedRefs.set(command.ref, command.newOid)
		}
	}
}
