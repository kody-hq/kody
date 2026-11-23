import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { importPrivateKeyPem } from '#worker/credentials/private-key-pem.ts'

export const jwtAlgorithms = [
	'RS256',
	'RS384',
	'RS512',
	'PS256',
	'PS384',
	'PS512',
	'ES256',
	'ES384',
	'ES512',
	'EdDSA',
	'HS256',
	'HS384',
	'HS512',
] as const
export const jwtKeyEncodings = ['base64', 'utf8', 'base64url'] as const
export const hmacJwtAlgorithms = ['HS256', 'HS384', 'HS512'] as const

export type JwtAlgorithm = (typeof jwtAlgorithms)[number]
export type JwtKeyEncoding = (typeof jwtKeyEncodings)[number]
export type HmacJwtAlgorithm = (typeof hmacJwtAlgorithms)[number]
export type AsymmetricJwtAlgorithm = Exclude<JwtAlgorithm, HmacJwtAlgorithm>

type SignJwtInput = {
	header?: Record<string, unknown>
	claims: Record<string, unknown>
} & (
	| {
			algorithm: AsymmetricJwtAlgorithm
			privateKeyPem: string
	  }
	| {
			algorithm: HmacJwtAlgorithm
			hmacKeyBytes: Uint8Array
	  }
)

export function isHmacJwtAlgorithm(
	algorithm: JwtAlgorithm,
): algorithm is HmacJwtAlgorithm {
	return (hmacJwtAlgorithms as ReadonlyArray<JwtAlgorithm>).includes(algorithm)
}

export async function signJwt(input: SignJwtInput) {
	const header = buildJwtHeader(input.algorithm, input.header ?? {})
	const signingInput = [
		utf8ToBase64Url(JSON.stringify(header)),
		utf8ToBase64Url(JSON.stringify(input.claims)),
	].join('.')
	const key =
		'hmacKeyBytes' in input
			? await importHmacKey(input.hmacKeyBytes, input.algorithm)
			: await importPrivateKey(input.privateKeyPem, input.algorithm)
	const signature = await crypto.subtle.sign(
		getSignAlgorithm(input.algorithm),
		key,
		new TextEncoder().encode(signingInput),
	)
	return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export type SignJwtWithSecretInput = {
	algorithm: JwtAlgorithm
	/** HMAC key encoding; only valid for HS* (defaults to base64). */
	keyEncoding?: JwtKeyEncoding
	/** JSON object field holding the key, e.g. service-account `private_key`. */
	jsonField?: string
	header?: Record<string, unknown>
	claims: Record<string, unknown>
}

/** Signs a JWT with key material read from a stored credential value. */
export async function signJwtWithSecret(
	secretValue: string,
	input: SignJwtWithSecretInput,
) {
	const secretMaterial = extractSecretMaterial({
		secretValue,
		jsonField: input.jsonField,
	})
	if (isHmacJwtAlgorithm(input.algorithm)) {
		return await signJwt({
			algorithm: input.algorithm,
			hmacKeyBytes: decodeHmacKeyMaterial({
				secretValue: secretMaterial,
				encoding: input.keyEncoding ?? 'base64',
				algorithm: input.algorithm,
			}),
			header: input.header,
			claims: input.claims,
		})
	}
	if (input.keyEncoding !== undefined) {
		throw new McpCallerError(
			'key_encoding is only valid when algorithm is HS256, HS384, or HS512.',
		)
	}
	return await signJwt({
		algorithm: input.algorithm,
		privateKeyPem: secretMaterial,
		header: input.header,
		claims: input.claims,
	})
}

export function extractSecretMaterial(input: {
	secretValue: string
	jsonField?: string | null
}) {
	if (!input.jsonField) return input.secretValue
	let parsed: unknown
	try {
		parsed = JSON.parse(input.secretValue)
	} catch {
		throw new McpCallerError('Signing key secret is not valid JSON.')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new McpCallerError('Signing key secret JSON must be an object.')
	}
	const value = (parsed as Record<string, unknown>)[input.jsonField]
	if (typeof value !== 'string' || value.trim() === '') {
		throw new McpCallerError(
			`Signing key secret JSON field "${input.jsonField}" must be a non-empty string.`,
		)
	}
	return value
}

function hmacMinKeyByteLength(algorithm: HmacJwtAlgorithm) {
	switch (algorithm) {
		case 'HS256':
			return 32
		case 'HS384':
			return 48
		case 'HS512':
			return 64
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

export function decodeHmacKeyMaterial(input: {
	secretValue: string
	encoding: JwtKeyEncoding
	algorithm: HmacJwtAlgorithm
}) {
	const bytes = decodeHmacKeyBytes(input)
	assertHmacKeyLength(bytes, input.algorithm)
	return bytes
}

function decodeHmacKeyBytes(input: {
	secretValue: string
	encoding: JwtKeyEncoding
}) {
	switch (input.encoding) {
		case 'utf8': {
			if (input.secretValue === '') {
				throw new McpCallerError(
					'HMAC signing key secret must be a non-empty string.',
				)
			}
			return new TextEncoder().encode(input.secretValue)
		}
		case 'base64':
			return decodeEncodedHmacKey(input.secretValue, 'base64', base64ToBytes)
		case 'base64url':
			return decodeEncodedHmacKey(
				input.secretValue,
				'base64url',
				base64UrlToBytes,
			)
		default: {
			const exhaustive: never = input.encoding
			throw new Error(`Unsupported HMAC key encoding: ${exhaustive}`)
		}
	}
}

function assertHmacKeyLength(
	hmacKeyBytes: Uint8Array,
	algorithm: HmacJwtAlgorithm,
) {
	const minBytes = hmacMinKeyByteLength(algorithm)
	if (hmacKeyBytes.byteLength < minBytes) {
		throw new McpCallerError(
			`HMAC signing key for ${algorithm} must be at least ${minBytes} bytes.`,
		)
	}
}

function decodeEncodedHmacKey(
	secretValue: string,
	encoding: Exclude<JwtKeyEncoding, 'utf8'>,
	decode: (value: string) => Uint8Array,
) {
	const normalized = secretValue.replace(/\s/g, '')
	if (!normalized) {
		throw new McpCallerError(
			'HMAC signing key secret must be a non-empty string.',
		)
	}
	let bytes: Uint8Array
	try {
		bytes = decode(normalized)
	} catch {
		throw new McpCallerError(
			`HMAC signing key secret is not valid ${encoding}.`,
		)
	}
	if (bytes.byteLength === 0) {
		throw new McpCallerError(
			'HMAC signing key secret must be a non-empty string.',
		)
	}
	return bytes
}

function buildJwtHeader(
	algorithm: JwtAlgorithm,
	header: Record<string, unknown>,
) {
	if (header.alg !== undefined && header.alg !== algorithm) {
		throw new McpCallerError(
			'JWT header alg must match the requested algorithm.',
		)
	}
	return {
		typ: 'JWT',
		...header,
		alg: algorithm,
	}
}

async function importHmacKey(
	hmacKeyBytes: Uint8Array,
	algorithm: HmacJwtAlgorithm,
) {
	assertHmacKeyLength(hmacKeyBytes, algorithm)
	try {
		return await crypto.subtle.importKey(
			'raw',
			hmacKeyBytes.buffer.slice(
				hmacKeyBytes.byteOffset,
				hmacKeyBytes.byteOffset + hmacKeyBytes.byteLength,
			) as ArrayBuffer,
			getImportAlgorithm(algorithm),
			false,
			['sign'],
		)
	} catch {
		throw new McpCallerError('HMAC signing key secret could not be imported.')
	}
}

async function importPrivateKey(
	privateKeyPem: string,
	algorithm: AsymmetricJwtAlgorithm,
) {
	return await importPrivateKeyPem({
		value: privateKeyPem,
		algorithm: getImportAlgorithm(algorithm),
		fits: `${algorithm}, which needs ${privateKeyKindFor(algorithm)}`,
	})
}

function privateKeyKindFor(algorithm: AsymmetricJwtAlgorithm) {
	switch (algorithm) {
		case 'RS256':
		case 'RS384':
		case 'RS512':
		case 'PS256':
		case 'PS384':
		case 'PS512':
			return 'an RSA key'
		case 'ES256':
		case 'ES384':
		case 'ES512':
			return `an EC ${ecdsaCurveName(algorithm)} key`
		case 'EdDSA':
			return 'an Ed25519 key'
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

function getImportAlgorithm(
	algorithm: JwtAlgorithm,
):
	| AlgorithmIdentifier
	| RsaHashedImportParams
	| HmacImportParams
	| EcKeyImportParams {
	switch (algorithm) {
		case 'HS256':
		case 'HS384':
		case 'HS512':
			return { name: 'HMAC', hash: jwtHashName(algorithm) }
		case 'RS256':
		case 'RS384':
		case 'RS512':
			return { name: 'RSASSA-PKCS1-v1_5', hash: jwtHashName(algorithm) }
		case 'PS256':
		case 'PS384':
		case 'PS512':
			return { name: 'RSA-PSS', hash: jwtHashName(algorithm) }
		case 'ES256':
		case 'ES384':
		case 'ES512':
			return { name: 'ECDSA', namedCurve: ecdsaCurveName(algorithm) }
		case 'EdDSA':
			return { name: 'Ed25519' }
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

function getSignAlgorithm(
	algorithm: JwtAlgorithm,
): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
	switch (algorithm) {
		case 'HS256':
		case 'HS384':
		case 'HS512':
			return { name: 'HMAC' }
		case 'RS256':
		case 'RS384':
		case 'RS512':
			return { name: 'RSASSA-PKCS1-v1_5' }
		case 'PS256':
		case 'PS384':
		case 'PS512':
			return {
				name: 'RSA-PSS',
				saltLength: pssSaltLength(algorithm),
			}
		case 'ES256':
		case 'ES384':
		case 'ES512':
			return { name: 'ECDSA', hash: jwtHashName(algorithm) }
		case 'EdDSA':
			return { name: 'Ed25519' }
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

function jwtHashName(
	algorithm: Exclude<JwtAlgorithm, 'EdDSA'>,
): 'SHA-256' | 'SHA-384' | 'SHA-512' {
	switch (algorithm) {
		case 'HS256':
		case 'RS256':
		case 'PS256':
		case 'ES256':
			return 'SHA-256'
		case 'HS384':
		case 'RS384':
		case 'PS384':
		case 'ES384':
			return 'SHA-384'
		case 'HS512':
		case 'RS512':
		case 'PS512':
		case 'ES512':
			return 'SHA-512'
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

function ecdsaCurveName(algorithm: 'ES256' | 'ES384' | 'ES512') {
	switch (algorithm) {
		case 'ES256':
			return 'P-256'
		case 'ES384':
			return 'P-384'
		case 'ES512':
			return 'P-521'
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}

function pssSaltLength(algorithm: 'PS256' | 'PS384' | 'PS512') {
	switch (algorithm) {
		case 'PS256':
			return 32
		case 'PS384':
			return 48
		case 'PS512':
			return 64
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unsupported JWT algorithm: ${exhaustive}`)
		}
	}
}
