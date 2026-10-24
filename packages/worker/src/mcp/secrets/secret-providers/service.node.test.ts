import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { readDeclaredSecretProviderId } from './declared-provider.ts'
import { getSecretProviderBinding } from './repo.ts'
import { clearProviderSecretCacheForTests } from './cache.ts'
import {
	createBrokenProviderRefMessage,
	createMissingProviderBindingMessage,
	createMissingProviderDoorSecretMessage,
	createProviderNoWebsitesMessage,
	createProviderPackageNotGrantedMessage,
} from './errors.ts'
import {
	bindSecretProvider,
	grantSecretProviderToPackage,
	inspectSecretProviderPackageGrant,
	resolveProviderSecret,
	revokeSecretProviderGrant,
	unbindSecretProvider,
	type SecretProviderInvoker,
} from './service.ts'

vi.mock('./declared-provider.ts', () => ({
	readDeclaredSecretProviderId: vi.fn(),
}))

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)
const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const canonicalRef = `i/${itemId}/password`
const providerId = '1password'
const ownerId = ownerIdFromStored('user-owner')
const doorSecretName = 'onePasswordServiceAccountToken'
const notGrantedMessage = createProviderPackageNotGrantedMessage({
	providerId,
	canonicalRef,
	packageName: 'deploy',
	approvalUrl:
		'https://kody.example/account/secret-providers/approve?provider=1password&ref=i%2Fbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb%2Fpassword&package_id=pkg-consumer&package=deploy',
})
const grantInput = {
	providerId,
	ref: canonicalRef,
	packageId: 'pkg-consumer',
}

function seedUser(sqlite: DatabaseSync, id: number, stableUserId: string) {
	sqlite
		.prepare(
			`INSERT INTO users (
				id, username, email, stable_user_id, password_hash, email_verified_at
			) VALUES (?, ?, ?, ?, 'x', CURRENT_TIMESTAMP)`,
		)
		.run(id, stableUserId, `${stableUserId}@example.com`, stableUserId)
}

function seedPackage(
	sqlite: DatabaseSync,
	id: string,
	kodyId: string,
	userId = ownerId,
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, ?, ?, '', ?)`,
		)
		.run(id, userId, kodyId, kodyId, `source-${id}`)
}

/**
 * Seeds the owner + guest accounts, the `op` provider package, the `deploy`
 * consumer package, the door secret, and a provider binding.
 */
async function createHarness(input: { bound?: boolean; userId?: string } = {}) {
	clearProviderSecretCacheForTests()
	const userId = input.userId ?? ownerId
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	seedUser(sqlite, 1, ownerId)
	seedUser(sqlite, 2, 'user-guest')
	seedPackage(sqlite, 'pkg-consumer', 'deploy', ownerIdFromStored(userId))
	if (input.bound !== false) {
		seedPackage(sqlite, 'pkg-provider', 'op', ownerIdFromStored(userId))
		await saveSecret({
			env,
			userId: ownerIdFromStored(userId),
			scope: 'user',
			name: doorSecretName,
			value: 'op-sa-token',
			audit: null,
		})
		await env.APP_DB.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, ?, 'pkg-provider', ?, '{}')`,
		)
			.bind(userId, providerId, doorSecretName)
			.run()
	}
	vi.mocked(readDeclaredSecretProviderId).mockResolvedValue(providerId)

	const invokeProvider = vi.fn<SecretProviderInvoker>(async (call) =>
		call.action === 'canonicalize'
			? { canonicalRef }
			: { value: 'item-password', hosts: ['https://app.example.com/login'] },
	)
	return {
		sqlite,
		env,
		invokeProvider,
		resolve: async (
			overrides: Partial<Parameters<typeof resolveProviderSecret>[0]> = {},
		) =>
			resolveProviderSecret({
				env,
				baseUrl: 'https://kody.example',
				userId: ownerIdFromStored(userId),
				request: sessionRequestContext(userId),
				provider: providerId,
				binding: await getSecretProviderBinding(env.APP_DB, {
					userId,
					providerId,
				}),
				ref: canonicalRef,
				invokeProvider,
				...overrides,
			}),
		grant: () =>
			grantSecretProviderToPackage({
				env,
				userId: ownerIdFromStored(userId),
				...grantInput,
				audit: null,
			}),
		isGranted: async (ref = canonicalRef) =>
			(
				await inspectSecretProviderPackageGrant({
					env,
					userId: ownerIdFromStored(userId),
					...grantInput,
					ref,
				})
			).alreadyGranted,
		bind: (packageId: string) =>
			bindSecretProvider({
				env,
				baseUrl: 'https://kody.example',
				userId: ownerIdFromStored(userId),
				providerId,
				packageId,
				doorSecretName,
				audit: null,
			}),
	}
}

test('provider resolve grants, hosts, cache, owner execute, share owner binding, and fail-closed paths', async () => {
	const h = await createHarness()
	const opRef = `op://Personal/${itemId}/password`

	await expect(
		h.resolve({ ref: opRef, authorityPackageId: 'pkg-consumer' }),
	).rejects.toThrow(notGrantedMessage)
	expect(h.invokeProvider).toHaveBeenCalledTimes(0)

	await expect(h.resolve({ ref: opRef })).resolves.toMatchObject({
		provider: providerId,
		canonicalRef,
		value: 'item-password',
		hosts: ['app.example.com'],
	})
	expect(h.invokeProvider).toHaveBeenCalledTimes(1)
	const cached = await h.resolve()
	expect(cached.value).toBe('item-password')
	expect(h.invokeProvider).toHaveBeenCalledTimes(1)

	await h.grant()
	expect(await h.isGranted(opRef)).toBe(true)
	clearProviderSecretCacheForTests()
	const packageUse = await h.resolve({ authorityPackageId: 'pkg-consumer' })
	expect(packageUse.value).toBe('item-password')
	expect(h.invokeProvider).toHaveBeenCalledTimes(2)

	clearProviderSecretCacheForTests()
	await expect(
		h.resolve({ invokeProvider: async () => ({ value: 'x', hosts: [] }) }),
	).rejects.toThrow(createProviderNoWebsitesMessage(providerId))
	await expect(
		h.resolve({
			ref: 'op://Vault/Item/password',
			invokeProvider: async () => ({ canonicalRef: 'not-canonical' }),
		}),
	).rejects.toThrow(createBrokenProviderRefMessage(providerId))

	h.sqlite
		.prepare(`DELETE FROM secret_entries WHERE name = ?`)
		.run(doorSecretName)
	clearProviderSecretCacheForTests()
	await expect(h.resolve()).rejects.toThrow(
		createMissingProviderDoorSecretMessage({ providerId, doorSecretName }),
	)
})

test('revoke drops a package grant before the next resolve', async () => {
	const h = await createHarness()
	await h.grant()
	await revokeSecretProviderGrant({
		env: h.env,
		userId: ownerId,
		...grantInput,
		audit: null,
	})
	expect(await h.isGranted()).toBe(false)
	await expect(
		h.resolve({ authorityPackageId: 'pkg-consumer' }),
	).rejects.toThrow(notGrantedMessage)
	expect(h.invokeProvider).not.toHaveBeenCalled()
})

test('rebind to a different package drops grants and the provider cache', async () => {
	const h = await createHarness()
	seedPackage(h.sqlite, 'pkg-provider-2', 'op-2')
	await h.grant()
	await h.resolve()
	expect(h.invokeProvider).toHaveBeenCalledTimes(1)

	await h.bind('pkg-provider')
	expect(await h.isGranted()).toBe(true)
	await h.resolve()
	expect(h.invokeProvider).toHaveBeenCalledTimes(2)

	await h.bind('pkg-provider-2')
	expect(await h.isGranted()).toBe(false)
	await expect(
		h.resolve({ authorityPackageId: 'pkg-consumer' }),
	).rejects.toThrow(notGrantedMessage)
	expect(h.invokeProvider).toHaveBeenCalledTimes(2)
})

test('unbind drops grants and refuses the next resolve; grant and inspect require a binding', async () => {
	const h = await createHarness()
	await h.grant()
	await unbindSecretProvider({
		env: h.env,
		userId: ownerId,
		providerId,
		audit: null,
	})
	const missingBinding = createMissingProviderBindingMessage(providerId)
	await expect(h.isGranted()).rejects.toThrow(missingBinding)
	await expect(h.resolve()).rejects.toThrow(missingBinding)
	expect(h.invokeProvider).not.toHaveBeenCalled()

	const unbound = await createHarness({ bound: false })
	await expect(unbound.grant()).rejects.toThrow(missingBinding)
	await expect(unbound.isGranted()).rejects.toThrow(missingBinding)
})
