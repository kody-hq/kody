/**
 * Execution Context Protocol (ECP) v1 envelopes: detached Ed25519 signatures
 * over a base64url payload string, with a per-use ASCII prefix so a frame
 * signature can never be replayed as a key set (or an HTTP request) and the
 * other way round. See docs/contributing/architecture/execution-context-protocol.md.
 *
 * WebCrypto only, so the same code runs in Workers and in the Node 22 CLI.
 */
import { base64UrlToBytes, bytesToBase64Url } from '../base64.ts'

export const ecpFrameSignaturePrefix = 'kody-ecp/1\n'
export const ecpKeySetSignaturePrefix = 'kody-ecp-keys/1\n'
export const ecpHttpSignaturePrefix = 'kody-ecp-http/1\n'

/** Context frames carry this `k`; server frames carry the frame-signing kid. */
export const ecpContextKeyId = 'ctx'

/** The only unsigned frame: a fixed keepalive with no data and no authority. */
export const ecpPingFrame = '{"t":"ping"}'
export const ecpPongFrame = '{"t":"pong"}'

export type Ed25519PublicJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string }
export type Ed25519PrivateJwk = Ed25519PublicJwk & { d: string }

export type EcpEnvelope = { p: string; s: string; k: string }

/** WebCrypto key type that resolves under both Workers and Node typings. */
export type EcpCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/

/**
 * Only `{ kty, crv, x }` is stored, sent and hashed. `alg`, `key_ops` and
 * `ext` are dropped: Node 22.23 exports `alg: "Ed25519"`, which workerd's
 * importKey rejects. Returns null for anything that is not an Ed25519 key.
 */
export function normalizeEd25519PublicJwk(
	value: unknown,
): Ed25519PublicJwk | null {
	if (!isRecord(value)) return null
	if (value.kty !== 'OKP' || value.crv !== 'Ed25519') return null
	if (typeof value.x !== 'string' || !base64UrlPattern.test(value.x)) {
		return null
	}
	if (base64UrlToBytes(value.x).byteLength !== 32) return null
	return { kty: 'OKP', crv: 'Ed25519', x: value.x }
}

export function normalizeEd25519PrivateJwk(
	value: unknown,
): Ed25519PrivateJwk | null {
	const pub = normalizeEd25519PublicJwk(value)
	if (!pub || !isRecord(value)) return null
	if (typeof value.d !== 'string' || !base64UrlPattern.test(value.d)) {
		return null
	}
	return { ...pub, d: value.d }
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) over `crv`, `kty`, `x`. */
export async function ed25519JwkThumbprint(jwk: Ed25519PublicJwk) {
	const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`
	const digest = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(canonical),
	)
	return bytesToBase64Url(new Uint8Array(digest))
}

export async function importEd25519PublicKey(jwk: Ed25519PublicJwk) {
	return await crypto.subtle.importKey(
		'jwk',
		{ kty: jwk.kty, crv: jwk.crv, x: jwk.x },
		{ name: 'Ed25519' },
		false,
		['verify'],
	)
}

export async function importEd25519PrivateKey(jwk: Ed25519PrivateJwk) {
	return await crypto.subtle.importKey(
		'jwk',
		{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d },
		{ name: 'Ed25519' },
		false,
		['sign'],
	)
}

export async function signDetached(input: {
	prefix: string
	message: string
	privateKey: EcpCryptoKey
}) {
	const signature = await crypto.subtle.sign(
		{ name: 'Ed25519' },
		input.privateKey,
		encoder.encode(input.prefix + input.message),
	)
	return bytesToBase64Url(new Uint8Array(signature))
}

export async function verifyDetached(input: {
	prefix: string
	message: string
	signature: string
	publicKey: EcpCryptoKey
}) {
	if (!base64UrlPattern.test(input.signature)) return false
	const signature = base64UrlToBytes(input.signature)
	if (signature.byteLength !== 64) return false
	try {
		return await crypto.subtle.verify(
			{ name: 'Ed25519' },
			input.publicKey,
			signature,
			encoder.encode(input.prefix + input.message),
		)
	} catch {
		return false
	}
}

export function encodeEnvelopePayload(payload: unknown) {
	return bytesToBase64Url(encoder.encode(JSON.stringify(payload)))
}

export function decodeEnvelopePayload(p: string): unknown {
	if (!base64UrlPattern.test(p)) return null
	try {
		return JSON.parse(decoder.decode(base64UrlToBytes(p)))
	} catch {
		return null
	}
}

export function parseEnvelope(value: unknown): EcpEnvelope | null {
	if (!isRecord(value)) return null
	const { p, s, k } = value
	if (typeof p !== 'string' || typeof s !== 'string' || typeof k !== 'string') {
		return null
	}
	if (!p || !s || !k) return null
	return { p, s, k }
}

export async function signEnvelope(input: {
	prefix: string
	payload: unknown
	privateKey: EcpCryptoKey
	kid: string
}): Promise<EcpEnvelope> {
	const p = encodeEnvelopePayload(input.payload)
	const s = await signDetached({
		prefix: input.prefix,
		message: p,
		privateKey: input.privateKey,
	})
	return { p, s, k: input.kid }
}

/** Verify before parsing: returns the decoded payload only for a valid signature. */
export async function verifyEnvelope(input: {
	prefix: string
	envelope: EcpEnvelope
	publicKey: EcpCryptoKey
}): Promise<unknown> {
	const ok = await verifyDetached({
		prefix: input.prefix,
		message: input.envelope.p,
		signature: input.envelope.s,
		publicKey: input.publicKey,
	})
	if (!ok) return null
	return decodeEnvelopePayload(input.envelope.p)
}
