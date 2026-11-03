import { env } from 'cloudflare:workers'
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { expect, test } from 'vitest'
import { resolveOAuthHelpers } from './oauth-helpers.ts'

/**
 * Runs in workerd against the real `OAUTH_KV` binding with no
 * `OAUTH_PROVIDER` (the vitest pool never goes through the provider's fetch
 * wrapper), so this proves the deferred `oauth-provider.mjs` additional
 * module resolves and evaluates in the worker runtime and that the
 * library-built helpers touch the provider's own keys.
 */
test('resolveOAuthHelpers loads the deferred provider module in workerd and revokes over OAUTH_KV', async () => {
	const userId = `oauth-helpers-workers-${crypto.randomUUID()}`
	const otherUserId = `${userId}-other`
	await Promise.all([
		env.OAUTH_KV.put(
			`grant:${userId}:grant-1`,
			JSON.stringify({
				id: 'grant-1',
				clientId: 'client-a',
				userId,
				scope: ['mcp'],
				metadata: {},
				createdAt: 1,
			}),
		),
		env.OAUTH_KV.put(
			`token:${userId}:grant-1:tok-1`,
			JSON.stringify({ id: 'tok-1', grantId: 'grant-1', userId }),
		),
		env.OAUTH_KV.put(
			`grant:${otherUserId}:grant-2`,
			JSON.stringify({
				id: 'grant-2',
				clientId: 'client-a',
				userId: otherUserId,
				scope: ['mcp'],
				metadata: {},
				createdAt: 1,
			}),
		),
	])

	const helpers = await resolveOAuthHelpers<OAuthHelpers>(env)
	expect(helpers).toBeDefined()
	if (!helpers) throw new Error('unreachable')

	const before = await helpers.listUserGrants(userId)
	expect(before.items.map((grant) => grant.id)).toEqual(['grant-1'])

	await helpers.revokeGrant('grant-1', userId)

	expect(await env.OAUTH_KV.get(`grant:${userId}:grant-1`)).toBeNull()
	expect(await env.OAUTH_KV.get(`token:${userId}:grant-1:tok-1`)).toBeNull()
	expect(await env.OAUTH_KV.get(`grant:${otherUserId}:grant-2`)).not.toBeNull()

	await env.OAUTH_KV.delete(`grant:${otherUserId}:grant-2`)
})
