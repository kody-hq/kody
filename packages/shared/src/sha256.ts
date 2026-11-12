import { bytesToBase64Url } from './base64.ts'
import { toHex } from './hex.ts'

export async function sha256Bytes(value: string | BufferSource) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		typeof value === 'string' ? new TextEncoder().encode(value) : value,
	)
	return new Uint8Array(digest)
}

export async function sha256Base64Url(value: string) {
	return bytesToBase64Url(await sha256Bytes(value))
}

export async function sha256Hex(value: string | BufferSource) {
	return toHex(await sha256Bytes(value))
}
