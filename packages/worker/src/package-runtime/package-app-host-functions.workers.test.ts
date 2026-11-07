import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { setupServedPackageApp } from '#worker/test-support/served-package-app.ts'

/**
 * `kody.appRateLimit`, `kody.appSpendGet` and `kody.appPublisherGet` are
 * host functions, not capabilities: a saved app reaches them through
 * `kody:runtime` without declaring them in `kody.app.capabilities`.
 */

const appSource = `import { kody } from 'kody:runtime'
export default {
	async fetch() {
		const msg = (e) => String(e?.message ?? e).slice(0, 300)
		const out = {}
		try { out.limit = await kody.appRateLimit({ key: 'visits', limit: 1, windowSeconds: 3600 }) } catch (e) { out.limitError = msg(e) }
		try { out.publisher = await kody.appPublisherGet({}) } catch (e) { out.publisherError = msg(e) }
		try { out.spend = await kody.appSpendGet({}) } catch (e) { out.spendError = msg(e) }
		try { out.me = await kody.metaGetCurrentUser({}) } catch (e) { out.meError = msg(e) }
		return Response.json(out)
	},
}`

test(
	'a signed-out visitor reaches the app rate limit, spend and publisher without declaring them',
	{ timeout: 120_000 },
	async () => {
		const t = await setupServedPackageApp({ appSource })
		const first = await t.serve({ visitor: null })
		expect(first.limitError).toBeUndefined()
		expect(first.limit).toMatchObject({
			allowed: true,
			remaining: 0,
			retryAfterSeconds: null,
		})
		expect(first.publisherError).toBeUndefined()
		expect(first.publisher).toEqual({
			user_id: t.ownerId,
			username: t.username,
			email: `${t.username}@example.com`,
			display_name: expect.any(String),
			org: { slug: t.username },
			source: 'personal-org',
		})
		expect(first.spendError).toBeUndefined()
		expect(first.spend).toMatchObject({
			month: expect.stringMatching(/^\d{4}-\d{2}$/),
			creditsMicroUsd: expect.any(Number),
			days: expect.any(Array),
		})
		expect(String(first.meError)).toMatch(/Authenticated MCP user is required/)

		// The same app-owned window is shared across visits.
		const second = await t.serve({ visitor: null })
		expect(second.limit).toMatchObject({ allowed: false, remaining: 0 })
	},
)

test(
	'the publisher visiting their app matches appPublisherGet().user_id',
	{ timeout: 120_000 },
	async () => {
		const t = await setupServedPackageApp({ appSource })
		const body = await t.serve({
			visitor: {
				userId: personIdFromStored(t.ownerId),
				username: t.username,
				role: 'owner',
			},
		})
		expect(body.meError).toBeUndefined()
		expect(body.publisherError).toBeUndefined()
		const me = body.me as { user_id: string }
		const publisher = body.publisher as { user_id: string }
		expect(publisher.user_id).toBe(t.ownerId)
		expect(me.user_id).toBe(publisher.user_id)
	},
)

test(
	'declaring a host function keeps working',
	{ timeout: 120_000 },
	async () => {
		const t = await setupServedPackageApp({
			appSource,
			capabilities: ['appRateLimit', 'appPublisherGet', 'appSpendGet'],
		})
		const body = await t.serve({ visitor: null })
		expect(body.limitError).toBeUndefined()
		expect(body.limit).toMatchObject({ allowed: true })
		expect(body.publisherError).toBeUndefined()
		expect(body.spendError).toBeUndefined()
	},
)
