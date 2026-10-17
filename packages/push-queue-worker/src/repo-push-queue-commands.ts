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
 * Per-ref tips this queue last landed, plus oids it already moved past.
 * A push is known-stale only when its old-oid is in `superseded` (a tip we
 * overwrote). An old-oid that merely disagrees with `tip` (e.g. an outside
 * writer advanced the ref) falls through to Artifacts so the cache cannot
 * wedge clients that already fetched the real tip.
 */
export type LandedRefState = {
	tip: string
	/** Recent tips this queue replaced; capped FIFO. */
	superseded: ReadonlyArray<string>
}

/** How many superseded oids to retain per ref (covers a large racing burst). */
export const landedRefSupersededLimit = 64

/**
 * True when every command's old-oid is a tip this queue already moved past.
 * Cache misses and unknown old-oids (outside writers) are not stale.
 */
export function allReceivePackCommandsKnownStale(
	commands: ReadonlyArray<ReceivePackCommand>,
	landedRefs: ReadonlyMap<string, LandedRefState>,
) {
	if (commands.length === 0) return false
	return commands.every((command) => {
		const state = landedRefs.get(command.ref)
		if (!state) return false
		if (command.oldOid === state.tip) return false
		return state.superseded.includes(command.oldOid)
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
 * Collect refs that report-status marked `ok` or `ng`. Understands plain and
 * sideband-wrapped (band 1) result bodies. Progress (band 2) is skipped;
 * fatals (band 3) end the scan.
 */
export function collectReportStatusRefOutcomes(body: Uint8Array): {
	ok: Set<string>
	ng: Set<string>
} {
	const ok = new Set<string>()
	const ng = new Set<string>()
	scanReportStatusPackets(body, (line) => {
		const trimmed = line.replace(/\n$/, '')
		if (trimmed.startsWith('ok ')) {
			const ref = trimmed.slice(3)
			if (ref) ok.add(ref)
			return
		}
		if (trimmed.startsWith('ng ')) {
			const rest = trimmed.slice(3)
			const space = rest.indexOf(' ')
			const ref = space === -1 ? rest : rest.slice(0, space)
			if (ref) ng.add(ref)
		}
	})
	return { ok, ng }
}

export function collectReportStatusOkRefs(body: Uint8Array): Set<string> {
	return collectReportStatusRefOutcomes(body).ok
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

function pushSuperseded(
	prior: ReadonlyArray<string>,
	oid: string | undefined,
): Array<string> {
	if (!oid || isZeroOid(oid)) return [...prior]
	if (prior.includes(oid)) return [...prior]
	const next = [...prior, oid]
	if (next.length <= landedRefSupersededLimit) return next
	return next.slice(next.length - landedRefSupersededLimit)
}

/**
 * Apply report-status onto the landed-ref cache: `ok` advances tip (and records
 * the previous tip / command old-oid as superseded); `ng` clears the entry so
 * a tip that moved outside the queue cannot wedge later valid pushes.
 */
export function applyReportStatusToLandedRefs(
	landedRefs: Map<string, LandedRefState>,
	commands: ReadonlyArray<ReceivePackCommand>,
	reportStatusBody: Uint8Array,
) {
	const { ok: okRefs, ng: ngRefs } =
		collectReportStatusRefOutcomes(reportStatusBody)
	for (const ref of ngRefs) {
		landedRefs.delete(ref)
	}
	if (okRefs.size === 0) return
	for (const command of commands) {
		if (!okRefs.has(command.ref)) continue
		if (isZeroOid(command.newOid)) {
			landedRefs.delete(command.ref)
			continue
		}
		const prior = landedRefs.get(command.ref)
		const superseded = pushSuperseded(
			prior?.superseded ?? [],
			prior?.tip ?? command.oldOid,
		)
		landedRefs.set(command.ref, { tip: command.newOid, superseded })
	}
}
