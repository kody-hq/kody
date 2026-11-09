/**
 * RSA request signing for a `signing` credential (ADR 0099). Kody builds the
 * signing string itself from the request a caller describes, so a signature
 * only ever covers a request to one of the credential's hosts. The scheme is
 * draft-cavage HTTP signatures (the one Oracle Cloud uses); `scheme` leaves
 * room for RFC 9421 later. Raw RSA-SHA256 over a caller's string is a
 * separate operation that the owner turns on per credential.
 *
 * Nothing here returns, logs, or puts the key into an error message.
 */
import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { normalizeHost } from '#worker/secrets/allowed-hosts.ts'
import { extractSecretMaterial } from '#mcp/capabilities/secrets/jwt-signing.ts'
import {
	assertHttpsUrl,
	CredentialRequestRefusedError,
} from './credential-request.ts'

export const httpSignatureSchemes = ['draft-cavage'] as const
export type HttpSignatureScheme = (typeof httpSignatureSchemes)[number]
export const httpSignatureProfiles = ['oracle', 'generic'] as const
export type HttpSignatureProfile = (typeof httpSignatureProfiles)[number]
export type HttpSignaturePlacement = 'authorization' | 'signature'

export type HttpSignatureOperation = {
	type: 'http-signature'
	/** Only `draft-cavage` today. */
	scheme?: HttpSignatureScheme
	/** `oracle` (default) follows Oracle Cloud's required headers. */
	profile?: HttpSignatureProfile
	keyId: string
	method: string
	url: string
	headers?: Record<string, string>
	body?: string
	/** Header names to sign, in order. Defaults follow the profile. */
	signedHeaders?: Array<string>
	placement?: HttpSignaturePlacement
	/** JSON object field holding the PEM key, like JWT signing. */
	jsonField?: string
}

export type RawRsaSignOperation = {
	type: 'rsa-sha256'
	message: string
	/** How `message` is encoded; `utf8` by default. */
	messageEncoding?: 'utf8' | 'base64'
	/** How the signature is returned; `base64` by default. */
	encoding?: 'base64' | 'base64url' | 'hex'
	jsonField?: string
}

/** The request Kody will sign: everything but the key. */
export type PreparedHttpSignature = {
	scheme: HttpSignatureScheme
	profile: HttpSignatureProfile
	host: string
	keyId: string
	signedHeaders: Array<string>
	signingString: string
	placement: HttpSignaturePlacement
	/** Headers Kody added that the request must carry, lower-case names. */
	addedHeaders: Record<string, string>
}

export const maxSignedBodyBytes = 5 * 1024 * 1024
const maxRawMessageBytes = 64 * 1024
const tokenPattern = /^[!#$%&'*+.^_`|~0-9a-z-]+$/
const methodPattern = /^[A-Za-z]+$/
const bodyMethods = new Set(['post', 'put', 'patch'])

function invalid(message: string): never {
	throw new CredentialRequestRefusedError('invalid_request', message)
}

function readHeaders(headers: unknown) {
	if (headers === undefined || headers === null)
		return new Map<string, string>()
	if (typeof headers !== 'object' || Array.isArray(headers)) {
		invalid('headers must be an object of header names to string values.')
	}
	const out = new Map<string, string>()
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase()
		if (!tokenPattern.test(name)) invalid(`"${rawName}" is not a header name.`)
		if (typeof rawValue !== 'string') {
			invalid(`The ${name} header must be a string.`)
		}
		if (/[\r\n\0]/.test(rawValue)) {
			invalid(`The ${name} header has a line break in it.`)
		}
		if (out.has(name)) invalid(`The ${name} header is set twice.`)
		out.set(name, rawValue.trim())
	}
	return out
}

function readUrl(raw: unknown) {
	if (typeof raw !== 'string' || raw === '') invalid('url must be a URL.')
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		invalid('url must be a full https:// URL.')
	}
	assertHttpsUrl(url)
	if (url.username || url.password) invalid('url must not carry a user name.')
	if (url.hash) invalid('url must not have a #fragment.')
	return url
}

async function sha256Base64(bytes: Uint8Array) {
	return bytesToBase64(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
		),
	)
}

function defaultSignedHeaders(
	profile: HttpSignatureProfile,
	dateHeader: 'date' | 'x-date',
	withBody: boolean,
) {
	if (profile === 'oracle') {
		return withBody
			? [
					dateHeader,
					'(request-target)',
					'host',
					'content-length',
					'content-type',
					'x-content-sha256',
				]
			: [dateHeader, '(request-target)', 'host']
	}
	return withBody
		? ['(request-target)', 'host', dateHeader, 'digest']
		: ['(request-target)', 'host', dateHeader]
}

/**
 * Validates a request and builds its draft-cavage signing string. Reads no
 * key, so the resolver runs it before authorizing the value read.
 */
export async function prepareHttpSignature(
	operation: HttpSignatureOperation,
	options: { now?: Date } = {},
): Promise<PreparedHttpSignature> {
	const scheme = operation.scheme ?? 'draft-cavage'
	if (!httpSignatureSchemes.includes(scheme)) {
		invalid('scheme must be "draft-cavage".')
	}
	const profile = operation.profile ?? 'oracle'
	if (!httpSignatureProfiles.includes(profile)) {
		invalid('profile must be "oracle" or "generic".')
	}
	const placement =
		operation.placement ??
		(profile === 'oracle' ? 'authorization' : 'signature')
	if (placement !== 'authorization' && placement !== 'signature') {
		invalid('placement must be "authorization" or "signature".')
	}
	if (
		typeof operation.keyId !== 'string' ||
		operation.keyId.trim() === '' ||
		/["\\\r\n\0]/.test(operation.keyId)
	) {
		invalid('keyId must be a non-empty string without quotes or line breaks.')
	}
	if (
		typeof operation.method !== 'string' ||
		!methodPattern.test(operation.method)
	) {
		invalid('method must be an HTTP method like GET or POST.')
	}
	const method = operation.method.toLowerCase()
	const url = readUrl(operation.url)
	const headers = readHeaders(operation.headers)
	for (const name of ['authorization', 'signature']) {
		if (headers.has(name))
			invalid(`Kody sets the ${name} header; leave it out.`)
	}
	const host = url.host.toLowerCase()
	const givenHost = headers.get('host')
	if (givenHost !== undefined && givenHost.toLowerCase() !== host) {
		invalid('The host header must match the URL host.')
	}
	headers.set('host', host)

	if (operation.body !== undefined && typeof operation.body !== 'string') {
		invalid('body must be a string, exactly as the request sends it.')
	}
	const bodyBytes =
		operation.body === undefined
			? null
			: new TextEncoder().encode(operation.body)
	if (bodyBytes && bodyBytes.byteLength > maxSignedBodyBytes) {
		invalid('body is too large to sign.')
	}
	const withBody =
		profile === 'oracle'
			? bodyMethods.has(method)
			: bodyBytes !== null && bodyBytes.byteLength > 0

	const added: Record<string, string> = {}
	const setComputed = (name: string, value: string) => {
		const given = headers.get(name)
		if (given !== undefined && given !== value) {
			invalid(`The ${name} header does not match the body Kody signs.`)
		}
		headers.set(name, value)
		if (given === undefined) added[name] = value
	}
	const dateHeader = headers.has('x-date') ? 'x-date' : 'date'
	if (!headers.has(dateHeader)) {
		setComputed('date', (options.now ?? new Date()).toUTCString())
	}
	const bytes = bodyBytes ?? new Uint8Array()
	if (withBody) {
		if (profile === 'oracle') {
			setComputed('x-content-sha256', await sha256Base64(bytes))
			setComputed('content-length', String(bytes.byteLength))
			if (!headers.has('content-type')) {
				setComputed('content-type', 'application/json')
			}
		} else {
			setComputed('digest', `SHA-256=${await sha256Base64(bytes)}`)
		}
	} else if (bodyBytes && bodyBytes.byteLength > 0) {
		invalid(
			`A ${operation.method.toUpperCase()} request with a body is not signed here.`,
		)
	}

	const signedHeaders = (
		operation.signedHeaders ??
		defaultSignedHeaders(profile, dateHeader, withBody)
	).map((name) => {
		if (typeof name !== 'string') invalid('signedHeaders must be header names.')
		return name.toLowerCase()
	})
	if (new Set(signedHeaders).size !== signedHeaders.length) {
		invalid('signedHeaders lists a header twice.')
	}
	// The signature must bind the destination, or it could be replayed elsewhere.
	for (const required of ['(request-target)', 'host']) {
		if (!signedHeaders.includes(required)) {
			invalid(`signedHeaders must include ${required}.`)
		}
	}
	if (withBody) {
		const digestHeader = profile === 'oracle' ? 'x-content-sha256' : 'digest'
		if (!signedHeaders.includes(digestHeader)) {
			invalid(`signedHeaders must include ${digestHeader} for a request body.`)
		}
	}
	const lines = signedHeaders.map((name) => {
		if (name === '(request-target)') {
			return `(request-target): ${method} ${url.pathname}${url.search}`
		}
		if (!tokenPattern.test(name)) invalid(`"${name}" is not a header name.`)
		const value = headers.get(name)
		if (value === undefined)
			invalid(`The ${name} header is signed but not set.`)
		return `${name}: ${value}`
	})
	return {
		scheme,
		profile,
		host: normalizeHost(url.hostname),
		keyId: operation.keyId,
		signedHeaders,
		signingString: lines.join('\n'),
		placement,
		addedHeaders: added,
	}
}

/** The headers to add to the request: the signature and any Kody computed. */
export function httpSignatureHeaders(
	prepared: PreparedHttpSignature,
	signature: string,
): Record<string, string> {
	const params = [
		...(prepared.profile === 'oracle' ? ['version="1"'] : []),
		`keyId="${prepared.keyId}"`,
		'algorithm="rsa-sha256"',
		`headers="${prepared.signedHeaders.join(' ')}"`,
		`signature="${signature}"`,
	].join(',')
	return {
		...prepared.addedHeaders,
		...(prepared.placement === 'authorization'
			? { authorization: `Signature ${params}` }
			: { signature: params }),
	}
}

const pkcs8RsaPrefix = [
	0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
	0x01, 0x01, 0x01, 0x05, 0x00,
]

function derLength(length: number) {
	if (length < 0x80) return [length]
	const bytes: Array<number> = []
	for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
	return [0x80 | bytes.length, ...bytes]
}

/** Wraps a PKCS#1 RSAPrivateKey in PKCS#8 PrivateKeyInfo. */
function pkcs1ToPkcs8(pkcs1: Uint8Array) {
	const octet = [0x04, ...derLength(pkcs1.length)]
	const bodyLength = pkcs8RsaPrefix.length + octet.length + pkcs1.length
	const out = new Uint8Array([
		0x30,
		...derLength(bodyLength),
		...pkcs8RsaPrefix,
		...octet,
		...pkcs1,
	])
	return out
}

const keyError =
	'The signing credential must hold an unencrypted RSA private key in PEM form (BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY).'

/** Imports a PKCS#8 or PKCS#1 PEM RSA key for RSASSA-PKCS1-v1_5 SHA-256. */
export async function importRsaSigningKey(pem: string) {
	const match =
		/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/.exec(
			pem,
		)
	if (!match || /Proc-Type:\s*4,ENCRYPTED/i.test(match[2]!)) {
		throw new Error(keyError)
	}
	try {
		const der = base64ToBytes(match[2]!.replace(/\s/g, ''))
		return await crypto.subtle.importKey(
			'pkcs8',
			match[1] ? pkcs1ToPkcs8(der) : der,
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['sign'],
		)
	} catch {
		throw new Error(keyError)
	}
}

async function rsaSha256(
	secretValue: string,
	jsonField: string | undefined,
	data: Uint8Array,
) {
	const key = await importRsaSigningKey(
		extractSecretMaterial({ secretValue, jsonField }),
	)
	return new Uint8Array(
		await crypto.subtle.sign(
			'RSASSA-PKCS1-v1_5',
			key,
			data as Uint8Array<ArrayBuffer>,
		),
	)
}

/** Signs a prepared request; returns only the headers to add. */
export async function signHttpRequest(
	secretValue: string,
	operation: HttpSignatureOperation,
	prepared: PreparedHttpSignature,
) {
	const signature = await rsaSha256(
		secretValue,
		operation.jsonField,
		new TextEncoder().encode(prepared.signingString),
	)
	return httpSignatureHeaders(prepared, bytesToBase64(signature))
}

/** Validates a raw-sign request without reading the key. */
export function readRawRsaMessage(operation: RawRsaSignOperation) {
	if (typeof operation.message !== 'string') {
		invalid('message must be a string.')
	}
	const messageEncoding = operation.messageEncoding ?? 'utf8'
	let bytes: Uint8Array
	if (messageEncoding === 'utf8') {
		bytes = new TextEncoder().encode(operation.message)
	} else if (messageEncoding === 'base64') {
		try {
			bytes = base64ToBytes(operation.message)
		} catch {
			invalid('message is not valid base64.')
		}
	} else {
		invalid('messageEncoding must be "utf8" or "base64".')
	}
	if (bytes.byteLength > maxRawMessageBytes)
		invalid('message is too large to sign.')
	const encoding = operation.encoding ?? 'base64'
	if (!['base64', 'base64url', 'hex'].includes(encoding)) {
		invalid('encoding must be "base64", "base64url", or "hex".')
	}
	return { bytes, encoding }
}

/** Raw RSA-SHA256 (RSASSA-PKCS1-v1_5) over the caller's bytes. */
export async function signRawRsaSha256(
	secretValue: string,
	operation: RawRsaSignOperation,
) {
	const { bytes, encoding } = readRawRsaMessage(operation)
	const signature = await rsaSha256(secretValue, operation.jsonField, bytes)
	switch (encoding) {
		case 'hex':
			return [...signature]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('')
		case 'base64url':
			return bytesToBase64(signature)
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, '')
		default:
			return bytesToBase64(signature)
	}
}
