import { z } from 'zod'

export const documentLimits = {
	contentBytes: 64 * 1024,
	stateBytes: 256 * 1024,
	historyBytes: 1024 * 1024,
	revisions: 20,
	files: 10,
	participants: 16,
} as const

export type Principal = {
	orgId: string
	personId: string
	name: string
	kind: 'person' | 'agent'
}
export type Revision = {
	id: string
	createdAt: string
	author: string
	bytes: number
	sha256: string
}
export type FileRecord = {
	id: string
	orgId: string
	name: string
	owner: string
	grants: Record<string, 'view' | 'edit'>
	location: 'included' | 'external'
	revisions: Array<Revision>
	previousLocation: 'included' | 'external' | null
	createdAt: string
}
export type DurableDocument = {
	file: FileRecord
	state: Uint8Array
	version: number
}
export const patchSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('anchor'),
		quote: z.string().min(1).max(documentLimits.contentBytes),
		replacement: z.string().max(documentLimits.contentBytes),
	}),
	z.object({
		kind: z.literal('replace'),
		baseVersion: z.number().int().nonnegative(),
		base: z.string().max(documentLimits.contentBytes),
		content: z.string().max(documentLimits.contentBytes),
	}),
])
export type DocumentPatch = z.infer<typeof patchSchema>
export const clientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('sync'), state: z.string().max(400_000) }),
	z.object({
		type: z.literal('update'),
		id: z.string().uuid(),
		update: z.string().max(400_000),
	}),
])

export function toBase64(bytes: Uint8Array) {
	let text = ''
	for (const byte of bytes) text += String.fromCharCode(byte)
	return btoa(text)
}
export function fromBase64(value: string) {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
export function byteLength(value: string) {
	return new TextEncoder().encode(value).byteLength
}
export async function checksum(value: string) {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}
