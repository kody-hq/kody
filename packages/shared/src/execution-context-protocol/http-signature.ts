/**
 * Signed HTTP requests (ECP 4.3). Header:
 * `Kody-ECP-Signature: ec=<ecid>, ts=<ms>, n=<nonce>, s=<sig>` over
 * `kody-ecp-http/1\n` + METHOD + `\n` + path and query + `\n` + ts + `\n` +
 * nonce + `\n` + base64url(sha256(body)).
 */
import { bytesToBase64Url } from '../base64.ts'
import {
	ecpHttpSignaturePrefix,
	signDetached,
	verifyDetached,
	type EcpCryptoKey,
} from './envelope.ts'

export const ecpSignatureHeader = 'Kody-ECP-Signature'
export const ecpSignatureNewKeyHeader = 'Kody-ECP-Signature-New'
export const ecpRunHeader = 'Kody-ECP-Run'

export const ecpHttpClockSkewMs = 60_000
export const ecpHttpNonceWindowMs = 120_000

export type EcpHttpSignature = { ec: string; ts: number; n: string; s: string }

const encoder = new TextEncoder()

export async function sha256Base64Url(body: Uint8Array | string) {
	const bytes =
		typeof body === 'string' ? encoder.encode(body) : new Uint8Array(body)
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return bytesToBase64Url(new Uint8Array(digest))
}

export async function ecpHttpSignatureInput(input: {
	method: string
	pathAndQuery: string
	ts: number
	nonce: string
	body: Uint8Array | string
}) {
	return [
		input.method.toUpperCase(),
		input.pathAndQuery,
		String(input.ts),
		input.nonce,
		await sha256Base64Url(input.body),
	].join('\n')
}

export function randomEcpNonce() {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

export function formatEcpSignatureHeader(signature: EcpHttpSignature) {
	return `ec=${signature.ec}, ts=${signature.ts}, n=${signature.n}, s=${signature.s}`
}

const headerFieldPattern = /^[A-Za-z0-9_.-]+$/

export function parseEcpSignatureHeader(
	value: string | null | undefined,
): EcpHttpSignature | null {
	if (!value) return null
	const fields = new Map<string, string>()
	for (const part of value.split(',')) {
		const index = part.indexOf('=')
		if (index <= 0) return null
		const key = part.slice(0, index).trim()
		const fieldValue = part.slice(index + 1).trim()
		if (!headerFieldPattern.test(fieldValue) || fields.has(key)) return null
		fields.set(key, fieldValue)
	}
	const ec = fields.get('ec')
	const tsText = fields.get('ts')
	const n = fields.get('n')
	const s = fields.get('s')
	if (!ec || !tsText || !n || !s || fields.size !== 4) return null
	if (!/^\d{1,16}$/.test(tsText)) return null
	return { ec, ts: Number(tsText), n, s }
}

export async function signEcpHttpRequest(input: {
	ec: string
	method: string
	pathAndQuery: string
	body: Uint8Array | string
	privateKey: EcpCryptoKey
	now?: number
	nonce?: string
}): Promise<EcpHttpSignature> {
	const ts = input.now ?? Date.now()
	const n = input.nonce ?? randomEcpNonce()
	const message = await ecpHttpSignatureInput({ ...input, ts, nonce: n })
	const s = await signDetached({
		prefix: ecpHttpSignaturePrefix,
		message,
		privateKey: input.privateKey,
	})
	return { ec: input.ec, ts, n, s }
}

/** Signature and clock check only; nonce uniqueness is the caller's store. */
export async function verifyEcpHttpSignature(input: {
	signature: EcpHttpSignature
	method: string
	pathAndQuery: string
	body: Uint8Array | string
	publicKey: EcpCryptoKey
	now?: number
}): Promise<'ok' | 'clock_skew' | 'bad_signature'> {
	const now = input.now ?? Date.now()
	if (Math.abs(now - input.signature.ts) > ecpHttpClockSkewMs) {
		return 'clock_skew'
	}
	const message = await ecpHttpSignatureInput({
		method: input.method,
		pathAndQuery: input.pathAndQuery,
		ts: input.signature.ts,
		nonce: input.signature.n,
		body: input.body,
	})
	const ok = await verifyDetached({
		prefix: ecpHttpSignaturePrefix,
		message,
		signature: input.signature.s,
		publicKey: input.publicKey,
	})
	return ok ? 'ok' : 'bad_signature'
}
