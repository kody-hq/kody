import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type PackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { KODY_DESCRIPTION_MAX_LENGTH } from '#worker/package-registry/types.ts'

const mockModule = vi.hoisted(() => ({
	assertWithinEntitlement: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	insertSavedPackage: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	scheduleKitSubscriberSync: vi.fn(),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	assertWithinEntitlement: (...args: Array<unknown>) =>
		mockModule.assertWithinEntitlement(...args),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	insertSavedPackage: (...args: Array<unknown>) =>
		mockModule.insertSavedPackage(...args),
}))

vi.mock('#worker/package-registry/vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/kit/subscriber-sync.ts', () => ({
	scheduleKitSubscriberSync: (...args: Array<unknown>) =>
		mockModule.scheduleKitSubscriberSync(...args),
}))

const { createStubSavedPackage } = await import('./create-stub-package.ts')

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.assertWithinEntitlement.mockResolvedValue(undefined)
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-new',
		bootstrapAccess: null,
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-1')
	mockModule.insertSavedPackage.mockResolvedValue(true)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.refreshSavedPackageProjection.mockResolvedValue({ record: {} })
}

const owner: PackageOwnerContext = {
	ownerUserId: ownerIdFromStored('user-1'),
	ownerScope: 'kentcdodds',
	ownerEmail: 'user-1@example.com',
	actorUserId: personIdFromStored('user-1'),
	actorPersonalOrgId: ownerIdFromStored('user-1'),
}

function create(
	args: Partial<Parameters<typeof createStubSavedPackage>[0]> & {
		kodyId: string
	},
) {
	resetMocks()
	return createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		owner,
		...args,
	})
}

test('createStubSavedPackage rejects invalid kody ids and registers stubs for personal and org scopes', async () => {
	const rejections = [
		{
			args: { kodyId: 'Not_A_Valid_Id' },
			error: /lower-kebab-case/,
			checksEntitlement: false,
		},
		{
			args: {
				kodyId: 'my-package',
				description: 'a'.repeat(KODY_DESCRIPTION_MAX_LENGTH + 1),
			},
			error: McpCallerError,
			checksEntitlement: true,
		},
		{
			args: { kodyId: '@other/my-package' },
			error: /does not match the acting owner "@kentcdodds"/,
			checksEntitlement: false,
		},
	]
	for (const { args, error, checksEntitlement } of rejections) {
		await expect(create(args)).rejects.toThrow(error)
		expect(mockModule.assertWithinEntitlement).toHaveBeenCalledTimes(
			checksEntitlement ? 1 : 0,
		)
		expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
		expect(mockModule.insertSavedPackage).not.toHaveBeenCalled()
	}

	await expect(
		create({ kodyId: '@kentcdodds/mailchimp' }),
	).resolves.toMatchObject({
		kodyId: 'mailchimp',
		name: '@kentcdodds/mailchimp',
	})

	const result = await create({
		kodyId: 'my-package',
		description: 'Does the thing.',
	})
	expect(result).toMatchObject({
		kodyId: 'my-package',
		name: '@kentcdodds/my-package',
	})
	expect(mockModule.assertWithinEntitlement).toHaveBeenCalledWith(
		expect.objectContaining({
			resource: 'saved_packages',
			userId: ownerIdFromStored('user-1'),
			email: 'user-1@example.com',
		}),
	)
	const syncedFiles = mockModule.syncArtifactSourceSnapshot.mock.calls[0]?.[0]
		?.files as Record<string, string>
	expect(syncedFiles['package.json']).toContain('"private": true')
	expect(syncedFiles['package.json']).not.toContain('"id"')
	expect(syncedFiles['README.md']).toContain('## Intent')
	expect(syncedFiles['AGENTS.md']).toContain('## Imports')
	expect(syncedFiles['AGENTS.md']).toContain('repoRunChecks')
	expect(syncedFiles['AGENTS.md']).toContain('packagePublishExternalPush')
	expect(syncedFiles['AGENTS.md']).toContain('commit, push, then')
	expect(syncedFiles['AGENTS.md']).toContain('refuse unpublished HEAD')
	expect(syncedFiles['AGENTS.md']).toContain(
		'Do not assume every agent can run the CLI.',
	)
	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			user_id: ownerIdFromStored('user-1'),
			name: '@kentcdodds/my-package',
			description: 'Does the thing.',
			source_id: 'source-new',
			has_app: 0,
			hidden: 0,
			is_private: 1,
		}),
		expect.anything(),
		{ actorUserId: personIdFromStored('user-1') },
	)
	expect(mockModule.insertSavedPackage.mock.calls[0]?.[1]).not.toHaveProperty(
		'kody_id',
	)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalled()
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalled()

	// Org-owned packages must persist under the org, not the acting member.
	await create({
		kodyId: 'team-tool',
		owner: {
			ownerUserId: ownerIdFromStored('org-owner'),
			ownerScope: 'acme',
			ownerEmail: 'acme@example.com',
			actorUserId: personIdFromStored('actor-1'),
			actorPersonalOrgId: ownerIdFromStored('actor-1'),
		},
	})
	expect(mockModule.assertWithinEntitlement).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('org-owner'),
			email: null,
		}),
	)
	expect(mockModule.ensureEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('org-owner') }),
	)
	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			user_id: ownerIdFromStored('org-owner'),
			name: '@acme/team-tool',
		}),
		expect.anything(),
		{ actorUserId: personIdFromStored('actor-1') },
	)
	// Insert stamps before projection refresh; Kit sync must fire here.
	expect(mockModule.scheduleKitSubscriberSync).toHaveBeenCalledWith({
		env: expect.anything(),
		stableUserId: personIdFromStored('actor-1'),
	})
	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: ownerIdFromStored('org-owner') }),
	)
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('org-owner') }),
	)
})

test('createStubSavedPackage skips Kit sync when the actor was already stamped', async () => {
	resetMocks()
	mockModule.insertSavedPackage.mockResolvedValueOnce(false)
	await createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://example.test',
		owner,
		kodyId: 'already-activated',
	})
	expect(mockModule.insertSavedPackage).toHaveBeenCalled()
	expect(mockModule.scheduleKitSubscriberSync).not.toHaveBeenCalled()
})
