import { expect, test } from 'vitest'
import { createMcpClientOAuthProvider } from './client-id-metadata.ts'
import { mcpOAuthRefreshTokenStorageKey } from './oauth-token-recovery.ts'
import {
	createSealedMcpOAuthStorage,
	mcpOAuthSecretServerId,
	sealLegacyMcpOAuthStorage,
} from './sealed-oauth-storage.ts'

const env = { SECRET_STORE_KEY: 'mcp-oauth-test-secret-store-key-32-chars' }
const callbackUrl = 'https://kody.test/mcp-oauth/callback'
const tokenKey = '/Kody/server-a/client-1/token'

function createMemoryStorage() {
	const values = new Map<string, unknown>()
	const storage = {
		put: async (key: string | Record<string, unknown>, value?: unknown) => {
			if (typeof key === 'string') values.set(key, value)
			else for (const [k, v] of Object.entries(key)) values.set(k, v)
		},
		get: async (key: string | Array<string>) =>
			Array.isArray(key)
				? new Map(
						key.filter((k) => values.has(k)).map((k) => [k, values.get(k)]),
					)
				: values.get(key),
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
		},
		list: async ({ prefix }: { prefix?: string } = {}) =>
			new Map(
				[...values.entries()].filter(([key]) =>
					prefix ? key.startsWith(prefix) : true,
				),
			),
	} as unknown as DurableObjectStorage
	return { storage, values }
}

function sealedView(storage: DurableObjectStorage, ownerId = 'owner-a') {
	return createSealedMcpOAuthStorage({
		storage,
		env,
		resolveOwnerId: () => ownerId,
	})
}

test('only OAuth secret keys are classified as sealed', () => {
	expect(mcpOAuthSecretServerId(tokenKey)).toBe('server-a')
	expect(mcpOAuthSecretServerId('/Kody/server-a/client-1/client_info/')).toBe(
		'server-a',
	)
	expect(mcpOAuthSecretServerId('/Kody/server-a/client-1/code_verifier')).toBe(
		'server-a',
	)
	expect(
		mcpOAuthSecretServerId('/Kody/server-a/client-1/code_verifier/nonce'),
	).toBe('server-a')
	expect(
		mcpOAuthSecretServerId(
			'/Kody/server-a/client-1/code_verifier_challenge/abc',
		),
	).toBe('server-a')
	expect(
		mcpOAuthSecretServerId(mcpOAuthRefreshTokenStorageKey('server-a')),
	).toBe('server-a')
	expect(mcpOAuthSecretServerId('/Kody/server-a/oauth_discovery')).toBeNull()
	expect(mcpOAuthSecretServerId('/Kody/server-a/state/nonce')).toBeNull()
	expect(mcpOAuthSecretServerId('mcp-oauth-attempt/server-a')).toBeNull()
})

test('provider tokens, client secrets, and verifiers round-trip as ciphertext at rest', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = createMcpClientOAuthProvider(
		sealedView(storage),
		callbackUrl,
	)
	provider.serverId = 'server-a'
	await provider.saveClientInformation({
		client_id: 'client-1',
		client_secret: 'dcr-client-secret',
		redirect_uris: [callbackUrl],
	})
	await provider.saveTokens({
		access_token: 'live-access-token',
		refresh_token: 'live-refresh-token',
		token_type: 'Bearer',
	})
	await provider.saveCodeVerifier('pkce-verifier-value')
	expect(await provider.tokens()).toMatchObject({
		access_token: 'live-access-token',
		refresh_token: 'live-refresh-token',
	})
	expect(await provider.clientInformation()).toMatchObject({
		client_secret: 'dcr-client-secret',
	})
	const verifiers = await sealedView(storage).list({
		prefix: '/Kody/server-a/client-1/code_verifier_challenge/',
	})
	expect([...verifiers.values()]).toEqual([
		expect.objectContaining({ verifier: 'pkce-verifier-value' }),
	])
	const raw = JSON.stringify([...values.entries()])
	for (const secret of [
		'live-access-token',
		'live-refresh-token',
		'dcr-client-secret',
		'pkce-verifier-value',
	]) {
		expect(raw).not.toContain(secret)
	}
	expect(values.get(tokenKey)).toMatch(/^v2\./)
})

test('a sealed token moved to another server, slot, or owner fails to open', async () => {
	const { storage, values } = createMemoryStorage()
	await sealedView(storage).put(tokenKey, { access_token: 'tok' })
	const ciphertext = values.get(tokenKey)
	values.set('/Kody/server-b/client-1/token', ciphertext)
	values.set('/Kody/server-a/client-2/token', ciphertext)
	await expect(
		sealedView(storage).get('/Kody/server-b/client-1/token'),
	).rejects.toThrow('Unable to decrypt platform secret.')
	await expect(
		sealedView(storage).get('/Kody/server-a/client-2/token'),
	).rejects.toThrow('Unable to decrypt platform secret.')
	await expect(sealedView(storage, 'owner-b').get(tokenKey)).rejects.toThrow(
		'Unable to decrypt platform secret.',
	)
	expect(await sealedView(storage).get(tokenKey)).toEqual({
		access_token: 'tok',
	})
})

test('plaintext OAuth secrets fail closed and are left for the backfill', async () => {
	const { storage, values } = createMemoryStorage()
	values.set(tokenKey, { access_token: 'legacy', token_type: 'Bearer' })
	values.set('/Kody/server-a/oauth_discovery', { issuer: 'x' })
	const provider = createMcpClientOAuthProvider(
		sealedView(storage),
		callbackUrl,
	)
	provider.serverId = 'server-a'
	provider.clientId = 'client-1'
	await expect(provider.tokens()).rejects.toThrow(
		'Unable to decrypt platform secret.',
	)
	expect(values.get(tokenKey)).toEqual({
		access_token: 'legacy',
		token_type: 'Bearer',
	})
	expect(values.get('/Kody/server-a/oauth_discovery')).toEqual({ issuer: 'x' })
})

test('the hub backfill seals every legacy secret key and is idempotent', async () => {
	const { storage, values } = createMemoryStorage()
	values.set(tokenKey, { access_token: 'a' })
	values.set('/Kody/server-a/client-1/client_info/', {
		client_id: 'client-1',
		client_secret: 's',
	})
	values.set(mcpOAuthRefreshTokenStorageKey('server-a'), {
		refresh_token: 'r',
	})
	values.set('/Kody/server-a/oauth_discovery', { issuer: 'x' })
	await sealedView(storage).put('/Kody/server-b/client-9/token', {
		access_token: 'b',
	})
	const run = (dryRun: boolean) =>
		sealLegacyMcpOAuthStorage({ storage, env, ownerId: 'owner-a', dryRun })
	expect(await run(true)).toEqual({
		scanned: 4,
		sealed: 0,
		remainingPlaintext: 3,
	})
	expect(await run(false)).toEqual({
		scanned: 4,
		sealed: 3,
		remainingPlaintext: 0,
	})
	expect(await run(false)).toEqual({
		scanned: 4,
		sealed: 0,
		remainingPlaintext: 0,
	})
	expect(await sealedView(storage).get(tokenKey)).toEqual({
		access_token: 'a',
	})
	expect(
		await sealedView(storage).get(mcpOAuthRefreshTokenStorageKey('server-a')),
	).toEqual({ refresh_token: 'r' })
})
