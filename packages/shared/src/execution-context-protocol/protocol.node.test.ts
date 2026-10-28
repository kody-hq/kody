import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { expect, test } from 'vitest'
import {
	EcpNonceWindow,
	checkNextSeq,
	classifyFrameText,
	ecpFrameSignaturePrefix,
	ecpKeySetSignaturePrefix,
	ed25519JwkThumbprint,
	frameSigningKeyExpiryWarning,
	importEd25519PrivateKey,
	importEd25519PublicKey,
	negotiateProtocol,
	normalizeEd25519PublicJwk,
	parseEcpSignatureHeader,
	parseFrameSigningKeys,
	selectFrameSigningKey,
	signEnvelope,
	signFrame,
	unexpiredKeys,
	unknownFrameTypeDisposition,
	verifyEcpHttpSignature,
	verifyFrame,
	verifyServerKeySet,
	type EcpEnvelope,
} from './index.ts'

const vectors = JSON.parse(
	readFileSync(new URL('./vectors/signing.json', import.meta.url), 'utf8'),
)
const testKeys = JSON.parse(
	readFileSync(new URL('./vectors/test-keys.json', import.meta.url), 'utf8'),
)
const productionKeySet = JSON.parse(
	readFileSync(
		new URL(
			'../../../worker/src/execution-contexts/server-keys.production.json',
			import.meta.url,
		),
		'utf8',
	),
)

test('signing vectors are exact (Ed25519 is deterministic)', async () => {
	const ctxKey = await importEd25519PrivateKey(testKeys.context)
	const serverKey = await importEd25519PrivateKey(testKeys.server.privateKeyJwk)
	expect(
		await signEnvelope({
			prefix: ecpFrameSignaturePrefix,
			payload: vectors.contextFrame.payload,
			privateKey: ctxKey,
			kid: 'ctx',
		}),
	).toEqual(vectors.contextFrame.envelope)
	expect(
		await signEnvelope({
			prefix: ecpFrameSignaturePrefix,
			payload: vectors.serverFrame.payload,
			privateKey: serverKey,
			kid: testKeys.server.kid,
		}),
	).toEqual(vectors.serverFrame.envelope)
	expect(await ed25519JwkThumbprint(vectors.contextPublicJwk)).toBe(
		vectors.contextThumbprint,
	)
	const publicKey = await importEd25519PublicKey(vectors.contextPublicJwk)
	expect(
		await verifyEcpHttpSignature({
			signature: parseEcpSignatureHeader(vectors.http.header)!,
			method: vectors.http.method,
			pathAndQuery: vectors.http.pathAndQuery,
			body: vectors.http.body,
			publicKey,
			now: vectors.http.signature.ts,
		}),
	).toBe('ok')
	expect(
		await verifyEcpHttpSignature({
			signature: parseEcpSignatureHeader(vectors.http.header)!,
			method: vectors.http.method,
			pathAndQuery: `${vectors.http.pathAndQuery}&x=1`,
			body: vectors.http.body,
			publicKey,
			now: vectors.http.signature.ts,
		}),
	).toBe('bad_signature')
	expect(
		await verifyEcpHttpSignature({
			signature: parseEcpSignatureHeader(vectors.http.header)!,
			method: vectors.http.method,
			pathAndQuery: vectors.http.pathAndQuery,
			body: vectors.http.body,
			publicKey,
			now: vectors.http.signature.ts + 61_000,
		}),
	).toBe('clock_skew')
})

test('the production key set verifies against pinned root-1 and the test set does not', async () => {
	const set = await verifyServerKeySet({ document: productionKeySet })
	expect(set?.keys).toEqual([
		{
			kid: 'ecp-frame-2026-10',
			x: '6TADcouO3btnE0Tunr1gGwKyvqmOWi7zhDg2vLoaTCE',
			notAfter: 1824940800000,
		},
	])
	expect(
		await verifyServerKeySet({ document: vectors.keySet.document }),
	).toBeNull()
	expect(
		await verifyServerKeySet({
			document: vectors.keySet.document,
			roots: [vectors.keySet.root],
		}),
	).toEqual(vectors.keySet.payload)
	const tampered = { ...productionKeySet, k: 'root-2' }
	expect(await verifyServerKeySet({ document: tampered })).toBeNull()
	const frameAsKeySet: EcpEnvelope = vectors.serverFrame.envelope
	expect(
		await verifyServerKeySet({
			document: { ...frameAsKeySet, k: vectors.keySet.root.kid },
			roots: [vectors.keySet.root],
		}),
	).toBeNull()
})

test('a frame signature is never accepted as a key set signature', async () => {
	const rootKey = await importEd25519PrivateKey(testKeys.root.privateKeyJwk)
	const asFrame = await signEnvelope({
		prefix: ecpFrameSignaturePrefix,
		payload: vectors.keySet.payload,
		privateKey: rootKey,
		kid: testKeys.root.kid,
	})
	expect(
		await verifyServerKeySet({
			document: asFrame,
			roots: [vectors.keySet.root],
		}),
	).toBeNull()
	const asKeySet = await signEnvelope({
		prefix: ecpKeySetSignaturePrefix,
		payload: vectors.keySet.payload,
		privateKey: rootKey,
		kid: testKeys.root.kid,
	})
	expect(
		await verifyServerKeySet({
			document: asKeySet,
			roots: [vectors.keySet.root],
		}),
	).not.toBeNull()
})

test('frames: seq regression and gaps are replays, clock skew is refused, pings are outside seq', async () => {
	const privateKey = await importEd25519PrivateKey(testKeys.context)
	const publicKey = await importEd25519PublicKey(vectors.contextPublicJwk)
	const now = 1793116800000
	const make = async (seq: number, ts = now) =>
		JSON.parse(
			await signFrame({
				privateKey,
				kid: 'ctx',
				payload: {
					v: 1,
					t: 'status',
					ec: 'ec_a',
					sid: 'ses_a',
					seq,
					ts,
					body: {},
				},
			}),
		) as EcpEnvelope
	const expect1 = { ec: 'ec_a', sid: 'ses_a', lastSeq: 0 }
	expect(
		(
			await verifyFrame({
				envelope: await make(1),
				publicKey,
				expect: expect1,
				now,
			})
		).ok,
	).toBe(true)
	for (const [seq, lastSeq] of [
		[1, 1],
		[3, 1],
		[0, 0],
	] as const) {
		expect(
			await verifyFrame({
				envelope: await make(seq),
				publicKey,
				expect: { ...expect1, lastSeq },
				now,
			}),
		).toEqual({ ok: false, code: 'replay' })
	}
	expect(
		await verifyFrame({
			envelope: await make(1, now - 61_000),
			publicKey,
			expect: expect1,
			now,
		}),
	).toEqual({ ok: false, code: 'clock_skew' })
	expect(
		await verifyFrame({
			envelope: await make(1),
			publicKey,
			expect: { ...expect1, sid: 'ses_other' },
			now,
		}),
	).toEqual({ ok: false, code: 'bad_signature' })
	expect(checkNextSeq(4, 5)).toBe('ok')
	expect(classifyFrameText('{"t":"ping"}')).toEqual({ kind: 'ping' })
})

test('unsigned frames other than the exact ping are rejected, including a ping with a payload', () => {
	for (const text of [
		'{"t":"ping","body":{"x":1}}',
		'{ "t": "ping" }',
		'{"t":"run.accept","body":{"runId":"run_1"}}',
		'not json',
	]) {
		expect(classifyFrameText(text)).toEqual({
			kind: 'invalid',
			code: 'bad_signature',
		})
	}
	expect(unknownFrameTypeDisposition('x-trace')).toBe('ignore')
	expect(unknownFrameTypeDisposition('run.explode')).toBe('unknown_type')
	expect(negotiateProtocol({ min: 1, max: 3 })).toBe(1)
	expect(negotiateProtocol({ min: 2, max: 3 })).toBeNull()
})

test('nonce replay is refused inside the window and allowed after it', () => {
	const window = new EcpNonceWindow(120_000)
	expect(window.consume('n1', 0)).toBe(true)
	expect(window.consume('n1', 119_999)).toBe(false)
	expect(window.consume('n1', 120_000)).toBe(true)
})

test('JWK alg stripping: Node exports alg, the normalized key carries only kty, crv, x', async () => {
	const { publicKey } = generateKeyPairSync('ed25519')
	const exported = {
		...publicKey.export({ format: 'jwk' }),
		alg: 'Ed25519',
		key_ops: ['verify'],
		ext: true,
	}
	const normalized = normalizeEd25519PublicJwk(exported)
	expect(Object.keys(normalized ?? {}).sort()).toEqual(['crv', 'kty', 'x'])
	await expect(importEd25519PublicKey(normalized!)).resolves.toBeTruthy()
	expect(normalizeEd25519PublicJwk({ kty: 'RSA', x: 'a' })).toBeNull()
})

test('frame signing keys: first unexpired signs, expired keys skip, 60-day warning', () => {
	const jwk = testKeys.server.privateKeyJwk
	const keys = parseFrameSigningKeys(
		JSON.stringify([
			{ kid: 'new', privateKeyJwk: jwk, notAfter: 3_000 },
			{ kid: 'old', privateKeyJwk: jwk, notAfter: 1_000 },
		]),
	)
	expect(selectFrameSigningKey(keys, 500)?.kid).toBe('new')
	expect(unexpiredKeys(keys, 500).map((key) => key.kid)).toEqual(['new', 'old'])
	expect(unexpiredKeys(keys, 1_500).map((key) => key.kid)).toEqual(['new'])
	const expiredFirst = parseFrameSigningKeys(
		JSON.stringify([
			{ kid: 'expired', privateKeyJwk: jwk, notAfter: 1_000 },
			{ kid: 'next', privateKeyJwk: jwk, notAfter: 5_000 },
		]),
	)
	expect(selectFrameSigningKey(expiredFirst, 2_000)?.kid).toBe('next')
	expect(() => parseFrameSigningKeys('[{"kid":"a"}]')).toThrow(/notAfter/)
	expect(() => parseFrameSigningKeys('not json')).not.toThrow(jwk.d)
	const day = 86_400_000
	const notAfter = 100 * day
	const keyList = [{ kid: 'k', notAfter }]
	expect(frameSigningKeyExpiryWarning(keyList, notAfter - 61 * day)).toBeNull()
	expect(
		frameSigningKeyExpiryWarning(keyList, notAfter - 60 * day),
	).toMatchObject({
		kid: 'k',
		daysLeft: 60,
	})
})
