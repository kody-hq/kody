import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { expect, test } from 'vitest'
import { resolveOAuthHelpers } from './oauth-helpers.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'

function grantRecord(
	id: string,
	userId: string,
	clientId: string,
	scope = ['mcp'],
) {
	return JSON.stringify({
		id,
		clientId,
		userId,
		scope,
		metadata: { label: id },
		createdAt: 1_700_000_000,
		encryptedProps: 'opaque',
		authCodeId: null,
	})
}

function tokenRecord(userId: string, grantId: string, id: string) {
	return JSON.stringify({
		id,
		grantId,
		userId,
		createdAt: 1_700_000_000,
		expiresAt: 1_700_003_600,
		wrappedEncryptionKey: 'opaque',
	})
}

function seedProviderKv() {
	const tokens: Array<[string, string, string]> = [
		['user-aaa', 'grant-1', 'tok-1'],
		['user-aaa', 'grant-1', 'tok-2'],
		['user-aaa', 'grant-2', 'tok-3'],
		['user-bbb', 'grant-3', 'tok-4'],
	]
	return createMemoryKvNamespace({
		'client:client-a': JSON.stringify({ clientId: 'client-a' }),
		'client:client-b': JSON.stringify({ clientId: 'client-b' }),
		'grant:user-aaa:grant-1': grantRecord('grant-1', 'user-aaa', 'client-a', [
			'mcp',
			'profile',
		]),
		'grant:user-aaa:grant-2': grantRecord('grant-2', 'user-aaa', 'client-b'),
		'grant:user-bbb:grant-3': grantRecord('grant-3', 'user-bbb', 'client-a'),
		...Object.fromEntries(
			tokens.map(([userId, grantId, id]) => [
				`token:${userId}:${grantId}:${id}`,
				tokenRecord(userId, grantId, id),
			]),
		),
	})
}

async function libraryHelpersFor(kv: KVNamespace) {
	const helpers = await resolveOAuthHelpers<OAuthHelpers>({
		OAUTH_KV: kv,
	} as Env)
	if (!helpers) throw new Error('expected library-backed OAuth helpers')
	return helpers
}

test('resolveOAuthHelpers prefers the injected provider helpers and needs OAUTH_KV otherwise', async () => {
	const injected = { listUserGrants: async () => ({ items: [] }) }
	await expect(
		resolveOAuthHelpers({ OAUTH_PROVIDER: injected } as Env & {
			OAUTH_PROVIDER: typeof injected
		}),
	).resolves.toBe(injected)
	await expect(resolveOAuthHelpers({} as Env)).resolves.toBeUndefined()
})

test('library-backed listUserGrants returns only the user’s grants in summary shape and pages with cursors', async () => {
	const { kv } = seedProviderKv()
	const helpers = await libraryHelpersFor(kv)

	const all = await helpers.listUserGrants('user-aaa')
	expect(all.cursor).toBeUndefined()
	expect(all.items).toEqual([
		expect.objectContaining({
			id: 'grant-1',
			clientId: 'client-a',
			userId: ownerIdFromStored('user-aaa'),
			scope: ['mcp', 'profile'],
			metadata: { label: 'grant-1' },
			createdAt: 1_700_000_000,
		}),
		expect.objectContaining({
			id: 'grant-2',
			clientId: 'client-b',
			userId: ownerIdFromStored('user-aaa'),
			scope: ['mcp'],
		}),
	])
	expect(JSON.stringify(all.items)).not.toMatch(/opaque|encryptedProps/)

	const firstPage = await helpers.listUserGrants('user-aaa', { limit: 1 })
	expect(firstPage.items.map((grant) => grant.id)).toEqual(['grant-1'])
	expect(firstPage.cursor).toBeDefined()
	const secondPage = await helpers.listUserGrants('user-aaa', {
		limit: 1,
		cursor: firstPage.cursor,
	})
	expect(secondPage.items.map((grant) => grant.id)).toEqual(['grant-2'])
	expect(secondPage.cursor).toBeUndefined()

	expect((await helpers.listUserGrants('user-none')).items).toEqual([])
})

test('library-backed revokeGrant deletes the grant and every token under it and nothing of another user', async () => {
	const { kv, store } = seedProviderKv()
	const helpers = await libraryHelpersFor(kv)

	await helpers.revokeGrant('grant-1', 'user-aaa')

	expect([...store.keys()].sort()).toEqual([
		'client:client-a',
		'client:client-b',
		'grant:user-aaa:grant-2',
		'grant:user-bbb:grant-3',
		'token:user-aaa:grant-2:tok-3',
		'token:user-bbb:grant-3:tok-4',
	])

	await expect(
		helpers.revokeGrant('grant-missing', 'user-aaa'),
	).resolves.toBeUndefined()
})

test('library-backed revokeGrant pages through more tokens than one list call returns', async () => {
	const { kv, store } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': grantRecord('grant-1', 'user-aaa', 'client-a'),
	})
	for (let index = 0; index < 1_250; index++) {
		store.set(
			`token:user-aaa:grant-1:tok-${String(index).padStart(4, '0')}`,
			tokenRecord('user-aaa', 'grant-1', `tok-${index}`),
		)
	}

	await (await libraryHelpersFor(kv)).revokeGrant('grant-1', 'user-aaa')

	expect(store.size).toBe(0)
})

test('library-backed deleteClient revokes every grant issued to the client across users and removes the client key', async () => {
	const { kv, store } = seedProviderKv()
	const helpers = await libraryHelpersFor(kv)

	await helpers.deleteClient('client-a')

	expect([...store.keys()].sort()).toEqual([
		'client:client-b',
		'grant:user-aaa:grant-2',
		'token:user-aaa:grant-2:tok-3',
	])
})
