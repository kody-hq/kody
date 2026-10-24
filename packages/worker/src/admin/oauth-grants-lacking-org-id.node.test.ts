import { expect, test, vi } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	parseOauthGrantKvKey,
	runOauthGrantsLackingOrgIdRevoke,
} from './oauth-grants-lacking-org-id.ts'

const revokeGrant = vi.fn<(grantId: string, userId: string) => Promise<void>>(
	async () => undefined,
)

vi.mock('#worker/oauth-helpers.ts', () => ({
	resolveOAuthHelpers: async () => ({
		listUserGrants: async () => ({ items: [] }),
		revokeGrant,
	}),
}))

vi.mock('#worker/oauth-refresh-family.ts', () => ({
	forgetRefreshFamilyGrant: vi.fn(async () => undefined),
}))

function grantJson(input: {
	id: string
	userId: string
	clientId: string
	orgId?: string
}) {
	return JSON.stringify({
		id: input.id,
		clientId: input.clientId,
		userId: input.userId,
		scope: ['mcp'],
		metadata: input.orgId ? { orgId: input.orgId } : { label: input.id },
		createdAt: 1_700_000_000,
		encryptedProps: 'opaque',
	})
}

test('parseOauthGrantKvKey accepts grant:userId:grantId only', () => {
	expect(parseOauthGrantKvKey('grant:user-a:grant-1')).toEqual({
		userId: 'user-a',
		grantId: 'grant-1',
	})
	expect(parseOauthGrantKvKey('grant:user-a:grant:extra')).toBeNull()
	expect(parseOauthGrantKvKey('token:user-a:grant-1:tok')).toBeNull()
	expect(parseOauthGrantKvKey('grant::grant-1')).toBeNull()
})

test('dry-run counts grants lacking metadata.orgId and does not revoke', async () => {
	revokeGrant.mockClear()
	const { kv } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-cursor',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-claude',
			orgId: 'org-stamped',
		}),
		'grant:user-b:grant-3': grantJson({
			id: 'grant-3',
			userId: 'user-b',
			clientId: 'client-cursor',
		}),
		'client:client-cursor': JSON.stringify({ clientId: 'client-cursor' }),
	})

	const result = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: true,
	})

	expect(result).toMatchObject({
		dryRun: true,
		scanned: 3,
		withOrgId: 1,
		lackingOrgId: 2,
		revoked: 0,
		usersLackingOrgId: 2,
		complete: true,
		nextCursor: null,
		failures: [],
	})
	expect(result.byClient).toEqual([{ clientId: 'client-cursor', count: 2 }])
	expect(revokeGrant).not.toHaveBeenCalled()
})

test('apply revokes lacking grants and a second pass finds zero', async () => {
	revokeGrant.mockClear()
	const { kv } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-cursor',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-claude',
			orgId: 'org-stamped',
		}),
		'grant:user-b:grant-3': grantJson({
			id: 'grant-3',
			userId: 'user-b',
			clientId: 'client-cursor',
		}),
	})
	revokeGrant.mockImplementation(async (grantId: string, userId: string) => {
		await kv.delete(`grant:${userId}:${grantId}`)
	})

	const applied = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
	})
	expect(applied).toMatchObject({
		dryRun: false,
		scanned: 3,
		lackingOrgId: 2,
		revoked: 2,
		withOrgId: 1,
		failures: [],
		complete: true,
	})
	expect(revokeGrant).toHaveBeenCalledTimes(2)

	const second = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: true,
	})
	expect(second).toMatchObject({
		scanned: 1,
		withOrgId: 1,
		lackingOrgId: 0,
		revoked: 0,
		usersLackingOrgId: 0,
		byClient: [],
		complete: true,
	})
})

test('vanished grants between list and get are skipped', async () => {
	revokeGrant.mockClear()
	const { kv, store } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-a',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-b',
			orgId: 'org-stamped',
		}),
	})
	const originalGet = kv.get.bind(kv)
	kv.get = (async (key: string, options?: string | { type?: string }) => {
		if (key === 'grant:user-a:grant-1') {
			store.delete(key)
			return null
		}
		return originalGet(key, options as never)
	}) as typeof kv.get

	const result = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
	})
	expect(result).toMatchObject({
		scanned: 2,
		withOrgId: 1,
		lackingOrgId: 0,
		revoked: 0,
		failures: [],
	})
	expect(revokeGrant).not.toHaveBeenCalled()
})

test('paged apply resumes with nextCursor across grant pages', async () => {
	revokeGrant.mockClear()
	const seed: Record<string, string> = {}
	for (let index = 0; index < 5; index += 1) {
		const id = `grant-${index}`
		const userId = `user-${index}`
		seed[`grant:${userId}:${id}`] = grantJson({
			id,
			userId,
			clientId: index % 2 === 0 ? 'client-even' : 'client-odd',
			...(index === 2 ? { orgId: 'org-stamped' } : {}),
		})
	}
	const { kv } = createMemoryKvNamespace(seed)
	revokeGrant.mockImplementation(async (grantId: string, userId: string) => {
		await kv.delete(`grant:${userId}:${grantId}`)
	})

	const page1 = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
		limit: 2,
	})
	expect(page1.complete).toBe(false)
	expect(page1.nextCursor).toEqual(expect.any(String))
	expect(page1.scanned).toBe(2)
	expect(page1.lackingOrgId).toBe(2)
	expect(page1.revoked).toBe(2)

	const page2 = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
		limit: 2,
		cursor: page1.nextCursor,
	})
	expect(page2.scanned).toBe(2)
	// One stamped + one lacking among the next two listed keys.
	expect(page2.withOrgId + page2.lackingOrgId).toBe(2)
	expect(page2.revoked).toBe(page2.lackingOrgId)

	const page3 = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
		limit: 2,
		cursor: page2.nextCursor,
	})
	expect(page3.complete).toBe(true)
	expect(page3.nextCursor).toBeNull()

	const verify = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: true,
	})
	expect(verify).toMatchObject({
		lackingOrgId: 0,
		complete: true,
	})
	expect(verify.withOrgId).toBeGreaterThanOrEqual(1)
})

test('apply records per-grant failures without aborting the page', async () => {
	revokeGrant.mockClear()
	revokeGrant.mockImplementation(async (grantId: string) => {
		if (grantId === 'grant-1') throw new Error('kv_unavailable')
	})
	const { kv } = createMemoryKvNamespace({
		'grant:user-a:grant-1': grantJson({
			id: 'grant-1',
			userId: 'user-a',
			clientId: 'client-a',
		}),
		'grant:user-a:grant-2': grantJson({
			id: 'grant-2',
			userId: 'user-a',
			clientId: 'client-b',
		}),
	})

	const result = await runOauthGrantsLackingOrgIdRevoke({
		env: { OAUTH_KV: kv } as Env,
		dryRun: false,
	})
	expect(result.revoked).toBe(1)
	expect(result.failures).toEqual([
		{
			grantId: 'grant-1',
			userId: 'user-a',
			clientId: 'client-a',
			error: 'kv_unavailable',
		},
	])
})
