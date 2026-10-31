/**
 * Server frame-signing key sets. Kody signs frames with the first unexpired
 * entry of `ECP_FRAME_SIGNING_KEYS`; contexts trust a frame kid only from a
 * key set document signed by a pinned root key (prefix `kody-ecp-keys/1`).
 */
import {
	decodeEnvelopePayload,
	ecpKeySetSignaturePrefix,
	importEd25519PublicKey,
	normalizeEd25519PrivateJwk,
	normalizeEd25519PublicJwk,
	parseEnvelope,
	verifyDetached,
	type EcpEnvelope,
	type Ed25519PrivateJwk,
	type Ed25519PublicJwk,
} from './envelope.ts'

export type EcpRootKey = { kid: string; x: string }

/**
 * Root public keys pinned in every CLI release. root-2 is the standby: it
 * signs nothing today, so a lost root-1 needs no emergency release.
 */
export const ecpRootPublicKeys: ReadonlyArray<EcpRootKey> = [
	{ kid: 'root-1', x: 'snJD_ruDIz9ejTdYyRuDT38rlmScNQyXSYpeUCxOBRQ' },
	{ kid: 'root-2', x: '8TMMLGTn67-wjqM4tU7hUcKtvEgENM2cE4DFjLdBz-w' },
]

/**
 * TEST ONLY: the committed root (`vectors/test-keys.json`, private key public)
 * that signs preview and local dev key sets. Never pinned by default; the CLI
 * adds it only behind `KODY_ECP_TRUST_TEST_ROOT=1` for workers.dev/localhost.
 */
export const ecpTestRootPublicKey: EcpRootKey = {
	kid: 'root-test-1',
	x: '6qRBa8n9QOpgMVvKw2Ck3hUGuaVAi0D-bNGjum0u5rk',
}

export type EcpPublishedKey = { kid: string; x: string; notAfter: number }

export type EcpKeySet = {
	v: 1
	keys: Array<EcpPublishedKey>
	issuedAt: number
}

export type EcpFrameSigningKey = {
	kid: string
	privateKeyJwk: Ed25519PrivateJwk
	notAfter: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePublishedKey(value: unknown): EcpPublishedKey | null {
	if (!isRecord(value)) return null
	const { kid, x, notAfter } = value
	if (typeof kid !== 'string' || !kid) return null
	if (typeof notAfter !== 'number' || !Number.isFinite(notAfter)) return null
	const jwk = normalizeEd25519PublicJwk({ kty: 'OKP', crv: 'Ed25519', x })
	if (!jwk) return null
	return { kid, x: jwk.x, notAfter }
}

export function parseKeySetPayload(value: unknown): EcpKeySet | null {
	if (!isRecord(value) || value.v !== 1) return null
	if (!Array.isArray(value.keys) || typeof value.issuedAt !== 'number') {
		return null
	}
	const keys: Array<EcpPublishedKey> = []
	for (const entry of value.keys) {
		const key = parsePublishedKey(entry)
		if (!key) return null
		keys.push(key)
	}
	return { v: 1, keys, issuedAt: value.issuedAt }
}

/**
 * Verify a key set document against the pinned roots. Returns null when the
 * document is malformed, names an unknown root, or the signature fails, so
 * an unsigned or wrongly signed key set is ignored.
 */
export async function verifyServerKeySet(input: {
	document: unknown
	roots?: ReadonlyArray<EcpRootKey>
}): Promise<EcpKeySet | null> {
	const envelope = parseEnvelope(input.document)
	if (!envelope) return null
	const root = (input.roots ?? ecpRootPublicKeys).find(
		(candidate) => candidate.kid === envelope.k,
	)
	if (!root) return null
	const rootJwk = normalizeEd25519PublicJwk({
		kty: 'OKP',
		crv: 'Ed25519',
		x: root.x,
	})
	if (!rootJwk) return null
	const ok = await verifyDetached({
		prefix: ecpKeySetSignaturePrefix,
		message: envelope.p,
		signature: envelope.s,
		publicKey: await importEd25519PublicKey(rootJwk),
	})
	if (!ok) return null
	return parseKeySetPayload(decodeEnvelopePayload(envelope.p))
}

/** Keys from a verified set that are still valid at `now`. */
export function unexpiredKeys<Key extends { notAfter: number }>(
	keys: ReadonlyArray<Key>,
	now: number,
): Array<Key> {
	return keys.filter((key) => key.notAfter > now)
}

export function publishedKeyJwk(key: EcpPublishedKey): Ed25519PublicJwk {
	return { kty: 'OKP', crv: 'Ed25519', x: key.x }
}

/**
 * Parse the `ECP_FRAME_SIGNING_KEYS` Worker credential: a JSON list of
 * `{ kid, privateKeyJwk, notAfter }`. Throws a message that never includes
 * key material.
 */
export function parseFrameSigningKeys(raw: string): Array<EcpFrameSigningKey> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error('ECP_FRAME_SIGNING_KEYS is not valid JSON.')
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error('ECP_FRAME_SIGNING_KEYS must be a non-empty JSON list.')
	}
	const kids = new Set<string>()
	return parsed.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(`ECP_FRAME_SIGNING_KEYS[${index}] is not an object.`)
		}
		const { kid, notAfter } = entry
		if (typeof kid !== 'string' || !kid) {
			throw new Error(`ECP_FRAME_SIGNING_KEYS[${index}] has no kid.`)
		}
		if (kids.has(kid)) {
			throw new Error(`ECP_FRAME_SIGNING_KEYS has a duplicate kid ${kid}.`)
		}
		kids.add(kid)
		if (typeof notAfter !== 'number' || !Number.isFinite(notAfter)) {
			throw new Error(`ECP_FRAME_SIGNING_KEYS[${index}] has no notAfter.`)
		}
		const privateKeyJwk = normalizeEd25519PrivateJwk(entry.privateKeyJwk)
		if (!privateKeyJwk) {
			throw new Error(
				`ECP_FRAME_SIGNING_KEYS[${index}] privateKeyJwk is not an Ed25519 private JWK.`,
			)
		}
		return { kid, privateKeyJwk, notAfter }
	})
}

/**
 * The key that signs: the first entry still valid at `now`. A key past
 * `notAfter` retires itself, so the next unexpired entry signs with no deploy.
 */
export function selectFrameSigningKey(
	keys: ReadonlyArray<EcpFrameSigningKey>,
	now: number,
): EcpFrameSigningKey | null {
	return keys.find((key) => key.notAfter > now) ?? null
}

/** Days of warning before the signing key's `notAfter` (health alert). */
export const ecpFrameKeyExpiryWarningDays = 60

export function frameSigningKeyExpiryWarning(
	keys: ReadonlyArray<{ kid: string; notAfter: number }>,
	now: number,
): { kid: string; notAfter: number; daysLeft: number } | null {
	const signing = keys.find((key) => key.notAfter > now)
	if (!signing) return null
	const daysLeft = (signing.notAfter - now) / 86_400_000
	if (daysLeft > ecpFrameKeyExpiryWarningDays) return null
	return {
		kid: signing.kid,
		notAfter: signing.notAfter,
		daysLeft: Math.floor(daysLeft),
	}
}

export type { EcpEnvelope }
