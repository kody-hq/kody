import { base64ToBytes, bytesToBase64 } from './base64.ts'
import { sha256Hex } from './sha256.ts'
import { toHex } from './hex.ts'

/**
 * JSON-stable encoding of a cell for content hashing and TSV artifacts.
 * Blobs become `{ "$b": "<base64>" }` so text and binary stay distinguishable.
 */
export type PacedD1EncodedCell =
	| null
	| boolean
	| number
	| string
	| { readonly $b: string }

export type PacedD1IndexEntry = {
	h: string
	k: Array<PacedD1EncodedCell>
}

function rank(value: PacedD1EncodedCell): number {
	if (value === null) return 0
	if (typeof value === 'number' || typeof value === 'bigint') return 1
	if (typeof value === 'boolean') return 1
	if (typeof value === 'string') return 2
	return 3
}

function asNumber(value: PacedD1EncodedCell): number {
	if (typeof value === 'boolean') return value ? 1 : 0
	if (typeof value === 'number') return value
	return Number(value)
}

/**
 * SQLite BINARY collation order for keyset / merge-join: NULL < numbers <
 * text (memcmp UTF-8) < blob.
 */
export function comparePacedD1Key(
	a: ReadonlyArray<PacedD1EncodedCell>,
	b: ReadonlyArray<PacedD1EncodedCell>,
): number {
	const length = Math.max(a.length, b.length)
	for (let i = 0; i < length; i++) {
		const left = a[i] ?? null
		const right = b[i] ?? null
		const rankLeft = rank(left)
		const rankRight = rank(right)
		if (rankLeft !== rankRight) return rankLeft - rankRight
		if (rankLeft === 0) continue
		if (rankLeft === 1) {
			const nLeft = asNumber(left)
			const nRight = asNumber(right)
			if (nLeft !== nRight) return nLeft < nRight ? -1 : 1
			continue
		}
		if (rankLeft === 2) {
			const leftBytes = new TextEncoder().encode(String(left))
			const rightBytes = new TextEncoder().encode(String(right))
			const cmp = compareBytes(leftBytes, rightBytes)
			if (cmp !== 0) return cmp
			continue
		}
		const leftBlob = base64ToBytes((left as { $b: string }).$b)
		const rightBlob = base64ToBytes((right as { $b: string }).$b)
		const cmp = compareBytes(leftBlob, rightBlob)
		if (cmp !== 0) return cmp
	}
	return 0
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		const left = a[i]!
		const right = b[i]!
		if (left !== right) return left < right ? -1 : 1
	}
	if (a.length === b.length) return 0
	return a.length < b.length ? -1 : 1
}

export function encodePacedD1Cell(value: unknown): PacedD1EncodedCell {
	if (value === null || value === undefined) return null
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error('paced D1 backup refuses non-finite numbers')
		}
		return value
	}
	if (typeof value === 'bigint') {
		if (
			value > BigInt(Number.MAX_SAFE_INTEGER) ||
			value < BigInt(Number.MIN_SAFE_INTEGER)
		) {
			throw new Error('paced D1 backup refuses unsafe bigint cells')
		}
		return Number(value)
	}
	if (typeof value === 'string') return value
	if (value instanceof ArrayBuffer) {
		return { $b: bytesToBase64(new Uint8Array(value)) }
	}
	if (ArrayBuffer.isView(value)) {
		return {
			$b: bytesToBase64(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		}
	}
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === 'number')
	) {
		return { $b: bytesToBase64(Uint8Array.from(value)) }
	}
	throw new Error(
		`paced D1 backup cannot encode cell of type ${Object.prototype.toString.call(value)}`,
	)
}

export function pacedD1RowLine(
	values: ReadonlyArray<PacedD1EncodedCell>,
): string {
	return JSON.stringify(values)
}

/** Truncated content hash stored in indexes (32 hex chars = 128 bits). */
export async function hashPacedD1RowLine(line: string): Promise<string> {
	return (await sha256Hex(line)).slice(0, 32)
}

export function addPacedD1Checksum(sumHex: string, rowHash: string): string {
	const sum = BigInt(`0x${sumHex || '0'}`)
	const next = (sum + BigInt(`0x${rowHash.slice(0, 16)}`)) & 0xffffffffffffffffn
	return next.toString(16).padStart(16, '0')
}

export function formatPacedD1IndexLine(entry: PacedD1IndexEntry): string {
	return `${entry.h}\t${JSON.stringify(entry.k)}\n`
}

export function parsePacedD1IndexLine(line: string): PacedD1IndexEntry {
	const tab = line.indexOf('\t')
	if (tab <= 0) throw new Error('invalid paced D1 index line')
	const h = line.slice(0, tab)
	const k = JSON.parse(line.slice(tab + 1)) as Array<PacedD1EncodedCell>
	if (!Array.isArray(k)) throw new Error('invalid paced D1 index key')
	return { h, k }
}

export type PacedD1DataUpsertLine = {
	kind: 'U'
	h: string
	k: Array<PacedD1EncodedCell>
	row: string
}

export type PacedD1DataDeleteLine = {
	kind: 'D'
	k: Array<PacedD1EncodedCell>
}

export type PacedD1DataLine = PacedD1DataUpsertLine | PacedD1DataDeleteLine

export function formatPacedD1UpsertLine(input: {
	h: string
	k: ReadonlyArray<PacedD1EncodedCell>
	row: string
}): string {
	return `U\t${input.h}\t${JSON.stringify(input.k)}\t${input.row}\n`
}

export function formatPacedD1DeleteLine(
	k: ReadonlyArray<PacedD1EncodedCell>,
): string {
	return `D\t${JSON.stringify(k)}\n`
}

export function parsePacedD1DataLine(line: string): PacedD1DataLine {
	if (line.startsWith('D\t')) {
		const k = JSON.parse(line.slice(2)) as Array<PacedD1EncodedCell>
		if (!Array.isArray(k)) throw new Error('invalid paced D1 delete line')
		return { kind: 'D', k }
	}
	if (!line.startsWith('U\t')) throw new Error('invalid paced D1 data line')
	const rest = line.slice(2)
	const firstTab = rest.indexOf('\t')
	const secondTab = rest.indexOf('\t', firstTab + 1)
	if (firstTab < 0 || secondTab < 0) {
		throw new Error('invalid paced D1 upsert line')
	}
	const h = rest.slice(0, firstTab)
	const k = JSON.parse(
		rest.slice(firstTab + 1, secondTab),
	) as Array<PacedD1EncodedCell>
	const row = rest.slice(secondTab + 1)
	if (!Array.isArray(k)) throw new Error('invalid paced D1 upsert key')
	return { kind: 'U', h, k, row }
}

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return toHex(new Uint8Array(digest))
}

export async function sha256HexOfText(text: string): Promise<string> {
	return sha256Hex(text)
}
