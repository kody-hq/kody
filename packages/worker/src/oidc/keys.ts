import { isolateState } from '@kody-internal/shared/isolate-state.ts'
import { signJwt } from '#worker/mcp/capabilities/secrets/jwt-signing.ts'

type RsaPublicJwk = {
	kty: 'RSA'
	n: string
	e: string
}

const signingKeyCache = isolateState(() => ({
	privateKey: null as CryptoKey | null,
	privateKeyPem: null as string | null,
	publicJwk: null as (RsaPublicJwk & { kid: string }) | null,
	publicJwkKid: null as string | null,
}))

function pemToArrayBuffer(pem: string) {
	const base64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/g, '')
		.replace(/-----END PRIVATE KEY-----/g, '')
		.replace(/\s/g, '')
	if (!base64) {
		throw new Error('OIDC signing private key PEM is empty.')
	}
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes.buffer
}

async function importOidcSigningPrivateKey(privateKeyPem: string) {
	if (
		signingKeyCache.current.privateKey &&
		signingKeyCache.current.privateKeyPem === privateKeyPem
	) {
		return signingKeyCache.current.privateKey
	}
	try {
		const key = await crypto.subtle.importKey(
			'pkcs8',
			pemToArrayBuffer(privateKeyPem),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			true,
			['sign'],
		)
		signingKeyCache.current.privateKey = key
		signingKeyCache.current.privateKeyPem = privateKeyPem
		signingKeyCache.current.publicJwk = null
		signingKeyCache.current.publicJwkKid = null
		return key
	} catch {
		throw new Error(
			'OIDC_SIGNING_PRIVATE_KEY_PEM must contain a valid PKCS#8 RSA private key.',
		)
	}
}

export function getOidcSigningKeyId(env: Env) {
	const kid = env.OIDC_SIGNING_KEY_ID?.trim()
	if (!kid) {
		throw new Error('Missing OIDC_SIGNING_KEY_ID for OIDC ID token signing.')
	}
	return kid
}

export function getOidcSigningPrivateKeyPem(env: Env) {
	const raw = env.OIDC_SIGNING_PRIVATE_KEY_PEM?.trim()
	if (!raw) {
		throw new Error(
			'Missing OIDC_SIGNING_PRIVATE_KEY_PEM for OIDC ID token signing.',
		)
	}
	// Preview/dotenv may store PKCS#8 PEMs with literal `\n` escapes.
	const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
	if (!pem.includes('BEGIN PRIVATE KEY')) {
		throw new Error(
			'OIDC_SIGNING_PRIVATE_KEY_PEM must contain a valid PKCS#8 PEM private key.',
		)
	}
	return pem
}

export async function getOidcSigningPublicJwk(env: Env) {
	const kid = getOidcSigningKeyId(env)
	if (
		signingKeyCache.current.publicJwk &&
		signingKeyCache.current.publicJwkKid === kid
	) {
		return signingKeyCache.current.publicJwk
	}
	const privateKeyPem = getOidcSigningPrivateKeyPem(env)
	const privateKey = await importOidcSigningPrivateKey(privateKeyPem)
	const exported = (await crypto.subtle.exportKey(
		'jwk',
		privateKey,
	)) as JsonWebKey
	if (exported.kty !== 'RSA' || !exported.n || !exported.e) {
		throw new Error('OIDC signing key must be an RSA key.')
	}
	signingKeyCache.current.publicJwk = {
		kty: 'RSA',
		n: exported.n,
		e: exported.e,
		kid,
	}
	signingKeyCache.current.publicJwkKid = kid
	return signingKeyCache.current.publicJwk
}

export async function getOidcJwksDocument(env: Env) {
	const publicJwk = await getOidcSigningPublicJwk(env)
	return {
		keys: [
			{
				...publicJwk,
				alg: 'RS256',
				use: 'sig',
			},
		],
	}
}

export async function signOidcJwt(
	env: Env,
	claims: Record<string, unknown>,
	header: Record<string, unknown> = {},
) {
	const privateKeyPem = getOidcSigningPrivateKeyPem(env)
	const kid = getOidcSigningKeyId(env)
	return signJwt({
		algorithm: 'RS256',
		privateKeyPem,
		header: { kid, ...header },
		claims,
	})
}

export async function verifyOidcJwtSignature(
	env: Env,
	jwt: string,
): Promise<Record<string, unknown> | null> {
	const segments = jwt.split('.')
	if (segments.length !== 3) return null
	const [encodedHeader, encodedPayload, encodedSignature] = segments
	if (!encodedHeader || !encodedPayload || !encodedSignature) return null

	let header: Record<string, unknown>
	let payload: Record<string, unknown>
	try {
		header = JSON.parse(
			new TextDecoder().decode(base64UrlToBytes(encodedHeader)),
		) as Record<string, unknown>
		payload = JSON.parse(
			new TextDecoder().decode(base64UrlToBytes(encodedPayload)),
		) as Record<string, unknown>
	} catch {
		return null
	}
	if (header.alg !== 'RS256') return null

	const publicJwk = await getOidcSigningPublicJwk(env)
	const key = await crypto.subtle.importKey(
		'jwk',
		{
			kty: 'RSA',
			n: publicJwk.n,
			e: publicJwk.e,
			alg: 'RS256',
		},
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	)
	const signingInput = `${encodedHeader}.${encodedPayload}`
	let signature: ArrayBuffer
	try {
		signature = base64UrlToBytes(encodedSignature)
	} catch {
		return null
	}
	const valid = await crypto.subtle.verify(
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		key,
		signature,
		new TextEncoder().encode(signingInput),
	)
	return valid ? payload : null
}

function base64UrlToBytes(value: string) {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/')
	const padding = (4 - (padded.length % 4)) % 4
	const base64 = padded + '='.repeat(padding)
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes.buffer
}
