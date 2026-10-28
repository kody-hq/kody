import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getCommunityForkByForkedPackageId: vi.fn(),
	getOrgById: vi.fn(),
	scheduleAllowedPackagesWouldBlock: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityForkByForkedPackageId: (...args: Array<unknown>) =>
		mockModule.getCommunityForkByForkedPackageId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('./service.ts', () => ({
	findSecret: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	getOrgById: (...args: Array<unknown>) => mockModule.getOrgById(...args),
}))

vi.mock('#worker/credentials/allowed-packages-safety-window.ts', () => ({
	tryAllowedPackagesSafetyWindowGrant: vi.fn(async () => false),
}))

vi.mock('#worker/credentials/allowed-packages-would-block.ts', () => ({
	scheduleAllowedPackagesWouldBlock: (...args: Array<unknown>) =>
		mockModule.scheduleAllowedPackagesWouldBlock(...args),
}))

const { assertPackageCanAccessResolvedSecret, PackageSecretAccessDeniedError } =
	await import('./package-access.ts')

const savedPackage = {
	id: 'pkg-1',
	kodyId: 'demo-package',
	name: 'demo-package',
	sourceId: 'source-1',
}
const unadoptedFork = {
	id: 'fork-1',
	forkedPackageId: 'pkg-1',
	adoptedAt: null,
}
const adoptedFork = { ...unadoptedFork, adoptedAt: '2026-07-01T00:00:00.000Z' }

const lockedElsewhere = {
	credentialId: 'cred-1',
	found: true as const,
	scope: 'user' as const,
	allowedHosts: [] as Array<string>,
	allowedPackages: ['pkg-other'],
	placement: null,
}

function accessInput(
	overrides: Partial<
		Parameters<typeof assertPackageCanAccessResolvedSecret>[0]
	> = {},
) {
	return {
		env: { APP_DB: {} as D1Database },
		baseUrl: 'https://example.com',
		orgSlug: 'ada',
		userId: ownerIdFromStored('owner-1'),
		storageContext: { sessionId: null, packageId: 'pkg-1' },
		secretName: 'apiToken',
		resolved: lockedElsewhere,
		...overrides,
	}
}

beforeEach(() => {
	mockModule.getSavedPackageById.mockReset()
	mockModule.getCommunityForkByForkedPackageId.mockReset()
	mockModule.getOrgById.mockReset()
	mockModule.scheduleAllowedPackagesWouldBlock.mockReset()
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.getOrgById.mockResolvedValue(null)
})

test('self-authored package outside a non-empty list is refused and records a would-block marker', async () => {
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(mockModule.scheduleAllowedPackagesWouldBlock).toHaveBeenCalledTimes(1)
	expect(mockModule.scheduleAllowedPackagesWouldBlock).toHaveBeenCalledWith({
		env: expect.anything(),
		marker: {
			ownerId: 'owner-1',
			credentialId: 'cred-1',
			packageId: 'pkg-1',
			accessKind: 'self_authored',
		},
	})
})

test('adopted fork outside a non-empty list is refused and records adopted', async () => {
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(adoptedFork)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(mockModule.scheduleAllowedPackagesWouldBlock).toHaveBeenCalledWith(
		expect.objectContaining({
			marker: expect.objectContaining({ accessKind: 'adopted' }),
		}),
	)
})

test('no marker when the list is empty or already lists the package', async () => {
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ resolved: { ...lockedElsewhere, allowedPackages: [] } }),
		),
	).resolves.toBeUndefined()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				resolved: { ...lockedElsewhere, allowedPackages: ['pkg-1'] },
			}),
		),
	).resolves.toBeUndefined()
	expect(mockModule.scheduleAllowedPackagesWouldBlock).not.toHaveBeenCalled()
})

test('no marker on paths that already deny or skip the exception', async () => {
	// Unadopted fork: denied as before.
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(unadoptedFork)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	// Mutate: always requires the list.
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput({ intent: 'mutate' })),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	// Nested call-site with a non-empty list: denied as before.
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ runContextPackageId: 'pkg-run' }),
		),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	// Non-user scope never reaches the check.
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ resolved: { ...lockedElsewhere, scope: 'app' as never } }),
		),
	).resolves.toBeUndefined()
	expect(mockModule.scheduleAllowedPackagesWouldBlock).not.toHaveBeenCalled()
})
