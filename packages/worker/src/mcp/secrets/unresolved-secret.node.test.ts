import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as SecretsRepo from './repo.ts'
import {
	parseMissingSecretMessage,
	parseSecretScopeUnavailableMessage,
} from './errors.ts'

const mockModule = vi.hoisted(() => ({
	listSecretLocationsByNameForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	getOrgById: vi.fn(
		async (..._args: Array<unknown>): Promise<{ slug: string } | null> => ({
			slug: 'acme',
		}),
	),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	getOrgById: (...args: Array<unknown>) => mockModule.getOrgById(...args),
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof SecretsRepo>()
	return {
		...actual,
		listSecretLocationsByNameForUser: (...args: Array<unknown>) =>
			mockModule.listSecretLocationsByNameForUser(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

const { createUnresolvedSecretMessage } = await import('./unresolved-secret.ts')

const env = { APP_DB: {} as D1Database }
const userId = ownerIdFromStored('user-1')
const secretName = 'discordBotToken'
const noPackage = {
	sessionId: null,
	appId: null,
	packageId: null,
	storageId: null,
}

function unresolved(
	input: Partial<Parameters<typeof createUnresolvedSecretMessage>[0]> = {},
) {
	return createUnresolvedSecretMessage({
		env,
		userId,
		name: secretName,
		baseUrl: 'https://example.com',
		...input,
	})
}

test('unresolved secret errors distinguish inaccessible scopes from a true miss', async () => {
	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([])
	expect(parseMissingSecretMessage(await unresolved())).toEqual({ secretName })

	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([
		{
			scope: 'package',
			binding_key: 'pkg-1',
			name: secretName,
			expires_at: null,
		},
	])
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'pkg-1',
		kodyId: 'discord-gateway',
		name: '@user/discord-gateway',
	})
	const packageMiss = await unresolved({ storageContext: noPackage })
	expect(parseMissingSecretMessage(packageMiss)).toBeNull()
	expect(parseSecretScopeUnavailableMessage(packageMiss)).toEqual({
		secretName,
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: false,
	})
	expect(packageMiss).toContain(
		'Prefer calling through an export of the owning package',
	)
	expect(packageMiss).toContain(
		"Changing the secret's scope is an explicit, owner-reviewed choice only",
	)
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(env.APP_DB, {
		userId,
		packageId: 'pkg-1',
	})

	const visibleInPackageRuntime = await unresolved({
		storageContext: { ...noPackage, packageId: 'pkg-1', storageId: 'pkg-1' },
	})
	expect(parseMissingSecretMessage(visibleInPackageRuntime)).toEqual({
		secretName,
	})

	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([
		{
			scope: 'user',
			binding_key: '',
			name: secretName,
			expires_at: null,
		},
	])
	const pinnedPackageMiss = await unresolved({
		scope: 'package',
		storageContext: noPackage,
	})
	expect(parseSecretScopeUnavailableMessage(pinnedPackageMiss)).toEqual({
		secretName,
		scope: 'user',
		packageName: null,
		packageId: null,
		missingPackageContext: false,
	})
	expect(pinnedPackageMiss).toContain(
		'https://example.com/@acme/-/secrets/user/discordBotToken',
	)
	expect(mockModule.getOrgById).toHaveBeenCalledWith(env.APP_DB, userId)

	mockModule.getOrgById.mockResolvedValueOnce(null)
	const noOrgMiss = await unresolved({
		scope: 'package',
		storageContext: noPackage,
	})
	expect(parseSecretScopeUnavailableMessage(noOrgMiss)).toEqual({
		secretName,
		scope: 'user',
		packageName: null,
		packageId: null,
		missingPackageContext: false,
	})
	expect(noOrgMiss).not.toContain('/secrets/')

	const dottedSecretName = 'grokBotWake.71e7550e-746d-417f-b253-05165975ff69'
	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([
		{
			scope: 'user',
			binding_key: '',
			name: dottedSecretName,
			expires_at: null,
		},
	])
	const dottedMiss = await unresolved({
		name: dottedSecretName,
		scope: 'package',
		storageContext: noPackage,
		baseUrl: 'https://kody.codes',
	})
	expect(dottedMiss).toContain(
		'https://kody.codes/@acme/-/secrets/user/grokBotWake%2E71e7550e-746d-417f-b253-05165975ff69',
	)
	expect(dottedMiss).not.toContain(
		'https://kody.codes/@acme/-/secrets/user/grokBotWake.71e7550e-746d-417f-b253-05165975ff69',
	)

	mockModule.listSecretLocationsByNameForUser.mockRejectedValue(
		new Error('d1 unavailable'),
	)
	expect(parseMissingSecretMessage(await unresolved())).toEqual({ secretName })
})

const owningPackageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
const otherPackageId = '11c7ff51-aa34-4ab8-94d6-bdd5e6af6d40'

test('unresolved package secrets name a job that lost package context and do not suggest widening scope', async () => {
	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([
		{
			scope: 'package',
			binding_key: owningPackageId,
			name: secretName,
			expires_at: null,
		},
	])
	mockModule.getSavedPackageById.mockResolvedValue({
		id: owningPackageId,
		kodyId: 'discord-gateway',
		name: '@user/discord-gateway',
		updatedAt: '2026-04-20T00:00:00.000Z',
	})

	const missingContext = await unresolved({
		storageContext: {
			...noPackage,
			storageId: `job:package-job:${owningPackageId}:nightly%20sync`,
		},
	})
	expect(parseSecretScopeUnavailableMessage(missingContext)).toEqual({
		secretName,
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: true,
	})
	expect(missingContext).toContain('job "nightly sync"')
	expect(missingContext).toContain('but its package context is missing')
	expect(missingContext).toContain(
		'package context last saved 2026-04-20T00:00:00.000Z',
	)
	expect(missingContext).toContain(
		"Do not widen the secret's scope to work around a missing package context",
	)
	expect(missingContext).not.toContain('Editor link:')
	expect(missingContext).not.toContain(
		'Prefer calling through an export of the owning package',
	)

	const stampedWrongPackageOnOwnedJob = await unresolved({
		storageContext: {
			...noPackage,
			packageId: otherPackageId,
			storageId: `job:package-job:${owningPackageId}:nightly`,
		},
	})
	expect(
		parseSecretScopeUnavailableMessage(stampedWrongPackageOnOwnedJob),
	).toMatchObject({
		missingPackageContext: true,
	})
	expect(stampedWrongPackageOnOwnedJob).toContain('job "nightly"')
	expect(stampedWrongPackageOnOwnedJob).not.toContain('Editor link:')

	const pinnedSessionOnOwnedJob = await unresolved({
		scope: 'session',
		storageContext: {
			...noPackage,
			storageId: `job:package-job:${owningPackageId}:nightly`,
		},
	})
	expect(parseSecretScopeUnavailableMessage(pinnedSessionOnOwnedJob)).toEqual({
		secretName,
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: false,
	})
	expect(pinnedSessionOnOwnedJob).toContain(
		'Prefer calling through an export of the owning package',
	)
	expect(pinnedSessionOnOwnedJob).not.toContain(
		'but its package context is missing',
	)

	const wrongPackageRuntime = await unresolved({
		storageContext: {
			...noPackage,
			packageId: otherPackageId,
			storageId: `job:package-job:${otherPackageId}:other-job`,
		},
	})
	expect(parseSecretScopeUnavailableMessage(wrongPackageRuntime)).toEqual({
		secretName,
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		missingPackageContext: false,
	})
	expect(wrongPackageRuntime).toContain(
		'Prefer calling through an export of the owning package',
	)
	expect(wrongPackageRuntime).toContain(
		"Changing the secret's scope is an explicit, owner-reviewed choice only",
	)
	expect(wrongPackageRuntime).toContain('/secrets/package/')
	expect(wrongPackageRuntime).not.toContain(
		'but its package context is missing',
	)
})
