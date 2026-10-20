import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
} from '#mcp/secrets/secret-authority.ts'
import * as secretService from '#mcp/secrets/service.ts'
import { type ListedSecret } from '#mcp/secrets/types.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { secretListCapability } from './secret-list.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getCommunityForkByForkedPackageId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityForkByForkedPackageId: (...args: Array<unknown>) =>
		mockModule.getCommunityForkByForkedPackageId(...args),
}))

const savedPackage = {
	id: 'pkg-1',
	kodyId: 'web-search',
	name: '@user/web-search',
	sourceId: 'source-1',
}

const communityFork = {
	id: 'fork-1',
	listingId: 'listing-1',
	forkerUserId: 'user-1',
	originCommit: 'abc123',
	forkedPackageId: 'pkg-1',
	forkedSourceId: 'source-1',
	targetKodyId: 'web-search',
	createdAt: '2026-01-01T00:00:00.000Z',
	adoptedAt: null,
	adoptionNote: null,
}

function secretMetadata(
	overrides: Partial<ListedSecret> & Pick<ListedSecret, 'name' | 'scope'>,
): ListedSecret {
	return {
		credentialId: `cred-${overrides.name}`,
		description: '',
		packageId: overrides.scope === 'package' ? 'pkg-1' : null,
		allowedHosts: [],
		allowedPackages: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
		placement: null,
		disconnected: false,
		...overrides,
	}
}

const listedSecrets = [
	secretMetadata({ name: 'BraveSearch', scope: 'user' }),
	secretMetadata({
		name: 'GrantedSearch',
		scope: 'user',
		allowedPackages: ['pkg-1'],
	}),
	secretMetadata({ name: 'packageToken', scope: 'package' }),
]

test('secretList matches implicit user-secret read access and still lists package secrets', async () => {
	const listSecretsSpy = vi
		.spyOn(secretService, 'listSecrets')
		.mockResolvedValue(listedSecrets)
	const env = { APP_DB: {} } as Env
	const executeContext = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
	const packageContext = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
			},
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: 'pkg-1',
				storageId: null,
			},
		}),
	}

	const executeListed = await secretListCapability.handler({}, executeContext)
	expect(executeListed.secrets.map((secret) => secret.name)).toEqual([
		'BraveSearch',
		'GrantedSearch',
		'packageToken',
	])
	expect(
		executeListed.secrets.find((secret) => secret.name === 'packageToken'),
	).toMatchObject({
		scope: 'package',
		package_id: 'pkg-1',
	})
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	const allNames = ['BraveSearch', 'GrantedSearch', 'packageToken']
	const grantedOnly = ['GrantedSearch', 'packageToken']
	const packageCases = [
		{ label: 'self-authored', pkg: savedPackage, fork: null, names: allNames },
		{
			label: 'adopted fork',
			pkg: savedPackage,
			fork: {
				...communityFork,
				adoptedAt: '2026-07-01T00:00:00.000Z',
				adoptionNote: 'Reviewed source; trusted for my use.',
			},
			names: allNames,
		},
		{
			label: 'unadopted fork',
			pkg: savedPackage,
			fork: communityFork,
			names: grantedOnly,
		},
		{ label: 'missing package', pkg: null, fork: null, names: grantedOnly },
	]
	for (const { label, pkg, fork, names } of packageCases) {
		mockModule.getSavedPackageById.mockResolvedValueOnce(pkg)
		mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(fork)
		const listed = await secretListCapability.handler({}, packageContext)
		expect({
			label,
			names: listed.secrets.map((secret) => secret.name),
		}).toEqual({ label, names })
	}
	expect(listSecretsSpy).toHaveBeenCalled()
	listSecretsSpy.mockRestore()
})

test('secretList from execute returns caller-owned package metadata with package_id', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	const userId = ownerIdFromStored('user-execute-list')
	await secretService.saveSecret({
		env,
		userId,
		scope: 'package',
		name: 'discordBotToken',
		value: 'package-only-value',
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-discord',
			storageId: 'pkg-discord',
		},
	})

	const listed = await secretListCapability.handler(
		{ scope: 'package' },
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored('user-execute-list'),
					email: `${userId}@example.com`,
					displayName: userId,
				},
			}),
		},
	)

	expect(listed.secrets).toEqual([
		expect.objectContaining({
			name: 'discordBotToken',
			scope: 'package',
			package_id: 'pkg-discord',
		}),
	])
	expect(listed.secrets[0]).not.toHaveProperty('value')
	expect(JSON.stringify(listed)).not.toContain('package-only-value')
})

test('secretList package scope uses declaring-package authority like secretSet', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	const userId = ownerIdFromStored('user-cross-pkg-list')
	const providerPackageId = 'pkg-provider'
	const consumerPackageId = 'pkg-consumer'
	const secretValue = 'provider-secret-value-must-not-leak'
	await secretService.saveSecret({
		env,
		userId,
		scope: 'package',
		name: 'providerToken',
		value: secretValue,
		description: 'provider owned',
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: providerPackageId,
			storageId: providerPackageId,
		},
	})
	await secretService.saveSecret({
		env,
		userId,
		scope: 'package',
		name: 'consumerToken',
		value: 'consumer-only-value',
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: consumerPackageId,
			storageId: consumerPackageId,
		},
	})

	const consumerContext = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-cross-pkg-list'),
				email: `${userId}@example.com`,
				displayName: userId,
			},
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: consumerPackageId,
				storageId: consumerPackageId,
			},
		}),
	}

	const direct = await secretListCapability.handler(
		{ scope: 'package' },
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored('user-cross-pkg-list'),
					email: `${userId}@example.com`,
					displayName: userId,
				},
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: providerPackageId,
					storageId: providerPackageId,
				},
			}),
		},
	)
	expect(direct.secrets.map((secret) => secret.name)).toEqual(['providerToken'])
	expect(direct.secrets[0]).toMatchObject({
		scope: 'package',
		package_id: providerPackageId,
		disconnected: false,
	})
	expect(JSON.stringify(direct)).not.toContain(secretValue)

	const imported = await runWithSecretAuthorityScope(
		new Set([providerPackageId, consumerPackageId]),
		() =>
			runWithCurrentSecretAuthority(providerPackageId, () =>
				secretListCapability.handler({ scope: 'package' }, consumerContext),
			),
	)
	expect(imported.secrets.map((secret) => secret.name)).toEqual([
		'providerToken',
	])
	expect(imported.secrets[0]).toMatchObject({
		scope: 'package',
		package_id: providerPackageId,
		disconnected: false,
	})
	expect(JSON.stringify(imported)).not.toContain(secretValue)

	const forged = await runWithSecretAuthorityScope(
		new Set([consumerPackageId]),
		() =>
			runWithCurrentSecretAuthority(providerPackageId, () =>
				secretListCapability.handler({ scope: 'package' }, consumerContext),
			),
	)
	expect(forged.secrets.map((secret) => secret.name)).toEqual(['consumerToken'])
	expect(forged.secrets[0]).toMatchObject({
		package_id: consumerPackageId,
	})
})
