import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createWaitUntilDrain } from '#worker/test-support/user-meter.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
async function seedOutboundFetchCounter(userId: string, count: number) {
	const day = utcDayKey()
	const updatedAt = new Date().toISOString()
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(
			userMeterDurableObjectName(ownerIdFromStored(userId)),
		),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.read({ resource: 'outbound_fetches_per_day', day })
		state.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO UPDATE SET
				count = excluded.count,
				revision = excluded.revision,
				updated_at = excluded.updated_at`,
			'outbound_fetches_per_day',
			day,
			count,
			updatedAt,
		)
	})
}

test('gateway fetches consume the daily outbound-fetch entitlement and deny over the plan limit', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `fetcher-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `fetcher-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'free',
		stableUserId: userId,
	})
	const props = {
		baseUrl: 'https://kody.example.com',
		userId: ownerIdFromStored(userId),
		email,
		request: null,
		storageContext: null,
	}
	const globalFetch = (async () =>
		new Response('ok')) as unknown as typeof fetch
	const drain = createWaitUntilDrain()

	const allowed = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	})
	expect(await allowed.text()).toBe('ok')
	await drain.drain()
	expect(
		await userMeterRpc({ env, userId: ownerIdFromStored(userId) }).read({
			resource: 'outbound_fetches_per_day',
			day: utcDayKey(),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })

	// Fill the remaining free-plan quota in UserMeter, then expect denial.
	await seedOutboundFetchCounter(
		userId,
		planLimits.free.maxOutboundFetchesPerDay,
	)
	const denied = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	}).catch((error: unknown) => error)
	expect(isEntitlementLimitError(denied)).toBe(true)

	// Callers that carry no email (MCP provider requests, package
	// runtime) still bind to the org's real plan instead of failing open
	// to the `max` quota.
	const deniedWithoutEmail = await executeGatewayFetch({
		env,
		props: { ...props, email: null },
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	}).catch((error: unknown) => error)
	expect(isEntitlementLimitError(deniedWithoutEmail)).toBe(true)

	// Contextless fetches (no userId) are not metered against a user and
	// pass through without consuming any counter.
	const contextless = await executeGatewayFetch({
		env,
		props: { ...props, userId: null, email: null },
		request: new Request('https://api.example.net/data'),
		globalFetch,
		waitUntil: drain.waitUntil,
	})
	expect(await contextless.text()).toBe('ok')
	await drain.drain()
}, 30_000)

test('gateway fetches for a converted org bill the org plan, not the founder personal plan', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `founder-${crypto.randomUUID()}@example.com`
	const orgId = testStableUserIdFromEmail(email)
	const suffix = crypto.randomUUID().slice(0, 8)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `founder-${suffix}`,
		plan: 'free',
		stableUserId: orgId,
	})
	// Conversion keeps the founder person id as the org id and moves the
	// founder onto a fresh Free personal org.
	const newPersonalOrgId = testStableUserIdFromEmail(`personal-${email}`)
	await ensurePersonalOrg(env.APP_DB, {
		stableUserId: orgId,
		orgId: newPersonalOrgId,
		username: `personal-${suffix}`,
		plan: 'free',
	})
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`UPDATE users SET personal_org_id = ? WHERE email = ?`,
		).bind(newPersonalOrgId, email),
		env.APP_DB.prepare(`UPDATE orgs SET plan = 'pro' WHERE id = ?`).bind(orgId),
	])
	await seedOutboundFetchCounter(
		orgId,
		planLimits.free.maxOutboundFetchesPerDay,
	)
	const drain = createWaitUntilDrain()
	const response = await executeGatewayFetch({
		env,
		props: {
			baseUrl: 'https://kody.example.com',
			userId: ownerIdFromStored(orgId),
			email: null,
			request: null,
			storageContext: null,
		},
		request: new Request('https://api.example.net/data'),
		globalFetch: (async () => new Response('ok')) as unknown as typeof fetch,
		waitUntil: drain.waitUntil,
	})
	expect(await response.text()).toBe('ok')
	await drain.drain()
}, 30_000)

test('workerd: gateway streams a progressing body and aborts a stalled one at the idle deadline', async () => {
	const encoder = new TextEncoder()
	const streamingFetch = (gapsMs: ReadonlyArray<number>) =>
		(async (request: Request) => {
			let index = 0
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const gapMs = gapsMs[index]
					if (gapMs === undefined) {
						controller.close()
						return
					}
					index += 1
					await new Promise((resolve) => {
						if (Number.isFinite(gapMs)) setTimeout(resolve, gapMs)
					})
					controller.enqueue(encoder.encode(`${index};`))
				},
			})
			const response = new Response(body, {
				headers: { 'content-type': 'text/event-stream' },
			})
			Object.defineProperty(response, 'url', { value: request.url })
			return response
		}) as unknown as typeof fetch
	const props = {
		baseUrl: 'https://kody.example.com',
		userId: null,
		email: null,
		request: null,
		storageContext: null,
	}

	const progressing = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/stream'),
		globalFetch: streamingFetch([30, 30, 30, 30, 30]),
		timeoutMs: 5_000,
		idleTimeoutMs: 80,
	})
	expect(progressing.url).toBe('https://api.example.net/stream')
	expect(progressing.headers.get('content-type')).toBe('text/event-stream')
	expect(await progressing.text()).toBe('1;2;3;4;5;')

	const stalled = await executeGatewayFetch({
		env,
		props,
		request: new Request('https://api.example.net/stall'),
		globalFetch: streamingFetch([0, Infinity]),
		timeoutMs: 5_000,
		idleTimeoutMs: 80,
	})
	await expect(stalled.text()).rejects.toThrow(
		'Outbound fetch response stalled: no bytes for 80ms.',
	)
}, 30_000)

test('workerd: gateway preserves the WebSocket upgrade when stripping upstream warnings', async () => {
	const pair = new WebSocketPair()
	const upgrade = new Response(null, {
		status: 101,
		webSocket: pair[0],
		headers: {
			'x-kody-legacy-credential-warning': 'forged',
			'x-kody-path-segment-warning': 'forged',
		},
	})
	const response = await executeGatewayFetch({
		env,
		props: {
			baseUrl: 'https://kody.example.com',
			userId: null,
			email: null,
			request: null,
			storageContext: null,
		},
		request: new Request('https://api.example.net/socket', {
			headers: { Upgrade: 'websocket' },
		}),
		globalFetch: (async () => upgrade) as unknown as typeof fetch,
		timeoutMs: 5_000,
		idleTimeoutMs: 80,
	})
	expect(response.status).toBe(101)
	expect(response.webSocket).toBe(pair[0])
	expect(response.headers.has('x-kody-legacy-credential-warning')).toBe(false)
	expect(response.headers.has('x-kody-path-segment-warning')).toBe(false)
}, 30_000)
