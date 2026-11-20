import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { resolveSecret, saveSecret } from '#mcp/secrets/service.ts'
import { createVaultItemCredential } from '#worker/credentials/vault-item-credential.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { invokeSealedSecretProvider } from './sealed-invoke.ts'
import { readDeclaredSecretProviderId } from './declared-provider.ts'
import { getSecretProviderBinding } from './repo.ts'
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
vi.mock('./sealed-invoke.ts', () => ({ invokeSealedSecretProvider: vi.fn() }))

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
	resetIsolateState()
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

test('a vault Key is usable by ID only through scoped egress with a live item grant and matching website', async () => {
	const stableId = testStableUserIdFromEmail('vault-owner@example.com')
	const ownerId = ownerIdFromStored(stableId)
	const h = await createHarness({ userId: ownerId })
	h.env.SENTRY_ENVIRONMENT = 'test'
	await provisionPersonalOrg(h.env.APP_DB, {
		stableUserId: ownerId,
		username: 'vault-owner',
		createdAt: '2026-10-10T00:00:00.000Z',
	})
	const actor = deriveRequestContext({
		user: { userId: personIdFromStored(stableId), username: 'vault-owner' },
		source: { kind: 'mcp-oauth' },
		orgBinding: { org: { id: ownerId, slug: 'vault-owner' }, role: 'owner' },
	})
	await h.bind('pkg-provider')
	const binding = await getSecretProviderBinding(h.env.APP_DB, {
		userId: ownerId,
		providerId,
	})
	const create = () =>
		createVaultItemCredential({
			env: h.env,
			ownerId,
			bindingId: binding!.credentialId,
			itemId,
			field: 'password',
			name: 'vault-key',
			hosts: ['app.example.com', 'other.example.com'],
			audit: createTestOrgAuditWriter({ appDb: h.env.APP_DB }),
		})
	await create()
	await expect(create()).rejects.toThrow('already uses this name')
	const row = h.sqlite
		.prepare(
			"SELECT id, config_json FROM secret_entries WHERE name = 'vault-key'",
		)
		.get() as { id: string; config_json: string }
	expect(row.config_json).not.toContain(canonicalRef)
	await expect(
		resolveSecret({
			env: h.env,
			userId: ownerId,
			name: 'vault-key',
			scope: 'user',
			storageContext: null,
		}),
	).resolves.toMatchObject({ found: false, value: null })

	const invoke = vi.mocked(invokeSealedSecretProvider)
	invoke.mockReset().mockResolvedValue({
		value: 'item-password',
		hosts: ['https://app.example.com/login'],
	})
	const apply = (host: string, attestedPackageId?: string) =>
		resolveCredential({
			env: h.env,
			orgId: ownerId,
			actor,
			baseUrl: 'https://kody.example',
			credential: {
				use: 'client-key',
				credentialId: row.id,
				requestUrl: new URL(`https://${host}/login`),
				attestedPackageId,
			},
		})
	const refusal =
		'requires an approved package, provider item grant, and matching website'
	await expect(apply('app.example.com')).rejects.toThrow(refusal)
	await expect(apply('app.example.com', 'pkg-consumer')).rejects.toThrow(
		refusal,
	)
	expect(invoke).not.toHaveBeenCalled()
	await h.grant()
	await expect(apply('app.example.com', 'pkg-consumer')).resolves.toMatchObject(
		{
			placement: {
				kind: 'header',
				name: 'Authorization',
				value: 'Bearer item-password',
			},
		},
	)
	await expect(apply('other.example.com', 'pkg-consumer')).rejects.toThrow(
		refusal,
	)
	await revokeSecretProviderGrant({
		env: h.env,
		userId: ownerId,
		...grantInput,
		audit: null,
	})
	await expect(apply('app.example.com', 'pkg-consumer')).rejects.toThrow(
		refusal,
	)
})

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
	resetIsolateState()
	const packageUse = await h.resolve({ authorityPackageId: 'pkg-consumer' })
	expect(packageUse.value).toBe('item-password')
	expect(h.invokeProvider).toHaveBeenCalledTimes(2)

	resetIsolateState()
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
	resetIsolateState()
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

test('a bound provider door follows the credential ID when the original name is reused', async () => {
	const h = await createHarness()
	await h.bind('pkg-provider')
	await h.grant()
	h.invokeProvider.mockClear()
	h.sqlite
		.prepare('UPDATE secret_entries SET name = ? WHERE name = ?')
		.run('renamed-door', doorSecretName)
	await saveSecret({
		env: h.env,
		userId: ownerId,
		scope: 'user',
		name: doorSecretName,
		value: 'different-door',
		audit: null,
	})
	await h.resolve()
	expect(h.invokeProvider).toHaveBeenCalledWith(
		expect.objectContaining({
			doorSecretName: 'renamed-door',
			doorSecretValue: 'op-sa-token',
		}),
	)
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
