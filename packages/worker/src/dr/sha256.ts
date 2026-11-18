import { toHex } from '@kody-internal/shared/hex.ts'

export async function sha256Hex(
	data: string | Uint8Array | ArrayBuffer,
): Promise<string> {
	const bytes =
		typeof data === 'string'
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data)
	// subtle.digest requires a BufferSource with an ArrayBuffer-backed view.
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const digest = await crypto.subtle.digest('SHA-256', copy)
	return toHex(new Uint8Array(digest))
}

/**
 * Hash a stream without buffering it. DigestStream is a Workers runtime
 * extension exposed on `crypto`, not a bare global.
 */
export async function sha256HexOfStream(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const digest = new (
		crypto as unknown as { DigestStream: typeof DigestStream }
	).DigestStream('SHA-256')
	await stream.pipeTo(digest)
	return toHex(new Uint8Array(await digest.digest))
}
