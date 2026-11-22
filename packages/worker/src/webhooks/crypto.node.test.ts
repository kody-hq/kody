import { createHmac } from 'node:crypto'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	buildWebhookDeliveryIdempotencyKey,
	buildWebhookTimestampBodyPayload,
	computeWebhookHmacSignature,
	generateWebhookUrlSecret,
	hashWebhookUrlSecret,
	isWebhookTimestampWithinTolerance,
	matchWebhookIngressUrlSecret,
	parseWebhookReplayTimestamp,
	providedWebhookHmacValues,
	verifyStandardWebhookSignature,
	verifyWebhookHmacSignature,
	webhookUrlSecretMatches,
} from './crypto.ts'

test('Standard Webhooks verifies the raw key and binds the ID, timestamp, and unmodified body', async () => {
	const key = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index))
	const deliveryId = 'msg_example'
	const timestampToken = '1745228724'
	const bodyText = '{ "value": 1 }'
	const body = new TextEncoder().encode(bodyText).buffer
	const signature = createHmac('sha256', key)
		.update(`${deliveryId}.${timestampToken}.${bodyText}`)
		.digest('base64')
	const valid = {
		secret: `whsec_${key.toString('base64')}`,
		deliveryId,
		timestampToken,
		body,
		provided: `v2a,ignored v1,${signature}`,
	}
	expect(await verifyStandardWebhookSignature(valid)).toBe(true)
	for (const change of [
		{ deliveryId: 'msg_other' },
		{ timestampToken: '1745228725' },
		{ body: new TextEncoder().encode('{"value":1}').buffer },
		{ provided: `v2a,${signature}` },
		{ secret: 'whsec_not-base64' },
		{ secret: key.toString('base64') },
	]) {
		expect(await verifyStandardWebhookSignature({ ...valid, ...change })).toBe(
			false,
		)
	}
})

test('webhook URL secrets hash for storage and compare in constant time', async () => {
	const secret = await generateWebhookUrlSecret()
	const hash = await hashWebhookUrlSecret(secret)
	expect(hash).not.toBe(secret)
	expect(
		await Promise.all(
			[secret, `${secret}x`].map((candidate) =>
				webhookUrlSecretMatches({ candidate, storedHash: hash }),
			),
		),
	).toEqual([true, false])

	const previous = await generateWebhookUrlSecret()
	const previousHash = await hashWebhookUrlSecret(previous)
	expect(
		await Promise.all(
			[secret, previous, `${secret}x`].map((candidate) =>
				matchWebhookIngressUrlSecret({
					candidate,
					currentHash: hash,
					previousHash,
				}),
			),
		),
	).toEqual(['current', 'previous', null])
})

function hmac(input: {
	secret: string
	body: ArrayBuffer
	prefix?: string
	provided?: string
}) {
	const options = {
		algorithm: 'hmac-sha256',
		encoding: 'hex',
		...input,
	} as const
	return input.provided === undefined
		? computeWebhookHmacSignature(options)
		: verifyWebhookHmacSignature({ ...options, provided: input.provided })
}

test('HMAC signatures cover GitHub-style prefixed hex and raw hex', async () => {
	const body = new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer
	const github = String(
		await hmac({ secret: 'topsecret', body, prefix: 'sha256=' }),
	)
	expect(github.startsWith('sha256=')).toBe(true)
	expect(
		await Promise.all(
			[github, 'sha256=00'].map((provided) =>
				hmac({ secret: 'topsecret', body, prefix: 'sha256=', provided }),
			),
		),
	).toEqual([true, false])

	const sentry = String(await hmac({ secret: 'sentry-secret', body }))
	expect(sentry.includes('=')).toBe(false)
	expect(await hmac({ secret: 'sentry-secret', body, provided: sentry })).toBe(
		true,
	)
})

test('webhook replay timestamps parse unix, iso, and stripe formats and reject missing or junk values', async () => {
	const body = new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer
	const unixSeconds = 1_780_000_000
	const unixMs = unixSeconds * 1000
	const iso = '2026-09-02T18:00:00.000Z'
	const parseCases = [
		[
			String(unixSeconds),
			'unix-seconds',
			{ ok: true, timestampMs: unixMs, timestampToken: String(unixSeconds) },
		],
		[
			String(unixMs),
			'unix-millis',
			{ ok: true, timestampMs: unixMs, timestampToken: String(unixMs) },
		],
		[
			iso,
			'iso-8601',
			{ ok: true, timestampMs: Date.parse(iso), timestampToken: iso },
		],
		[
			`t=${unixSeconds},v1=abc`,
			'stripe-signature',
			{ ok: true, timestampMs: unixMs, timestampToken: String(unixSeconds) },
		],
		[null, 'unix-seconds', { ok: false, reason: 'missing' }],
		['not-a-time', 'iso-8601', { ok: false, reason: 'unparseable' }],
	] as const
	expect(
		parseCases.map(([headerValue, format]) =>
			parseWebhookReplayTimestamp({ headerValue, format }),
		),
	).toEqual(parseCases.map(([, , want]) => want))
	expect(
		[299_000, 301_000].map((skewMs) =>
			isWebhookTimestampWithinTolerance({
				timestampMs: unixMs,
				nowMs: unixMs + skewMs,
				toleranceSeconds: 300,
			}),
		),
	).toEqual([true, false])

	const timestampPayload = buildWebhookTimestampBodyPayload({
		timestampToken: String(unixSeconds),
		body,
	})
	const timestampBodySignature = String(
		await hmac({ secret: 'whsec_test', body: timestampPayload }),
	)
	expect(
		await Promise.all(
			[body, timestampPayload].map((signedBody) =>
				hmac({
					secret: 'whsec_test',
					body: signedBody,
					provided: timestampBodySignature,
				}),
			),
		),
	).toEqual([false, true])
	expect(
		providedWebhookHmacValues({
			provided: `t=${unixSeconds},v1=${timestampBodySignature}`,
			verificationHeader: 'Stripe-Signature',
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
		}),
	).toEqual([timestampBodySignature])

	const [firstKey, sameKey, otherKey] = await Promise.all(
		['delivery-1', 'delivery-1', 'delivery-2'].map((deliveryId) =>
			buildWebhookDeliveryIdempotencyKey({
				userId: ownerIdFromStored('user-1'),
				packageId: 'pkg-1',
				webhookName: 'github',
				deliveryId,
			}),
		),
	)
	expect(firstKey).toBe(sameKey)
	expect(firstKey).not.toBe(otherKey)
	expect(firstKey).toMatch(/^[0-9a-f]{64}$/)
})
