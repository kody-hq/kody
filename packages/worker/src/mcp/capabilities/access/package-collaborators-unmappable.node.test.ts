import type * as UnmappableCredentialsModule from '#worker/credentials/package-unmappable-credentials.ts'
import type * as PackageRegistryRepoModule from '#worker/package-registry/repo.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	collaboratorCapabilityContext,
	collaboratorPeople,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

const prodDb = [
	{
		needKey: 'rooms-db',
		credentialName: 'Prod DB',
		reason: 'publisher' as const,
	},
]

const mocks = vi.hoisted(() => ({
	resolveSavedPackage: vi.fn(),
	locked: new Set<string>(),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageRegistryRepoModule>()),
	getSavedPackageById: async (_db: unknown, input: { packageId: string }) => ({
		id: input.packageId,
		name: 'demo-package',
	}),
}))

vi.mock(
	'#worker/credentials/package-unmappable-credentials.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof UnmappableCredentialsModule>()
		const load = async (input: { packageIds: ReadonlyArray<string> }) =>
			new Map(
				input.packageIds
					.filter((id) => mocks.locked.has(id))
					.map((id) => [id, prodDb]),
			)
		return {
			...actual,
			loadPackageUnmappableCredentials: load,
			loadOnePackageUnmappableCredentials: async (input: {
				packageId: string
			}) => (mocks.locked.has(input.packageId) ? prodDb : []),
		}
	},
)

const { packageCollaboratorListCapability, packageCollaboratorSetCapability } =
	await import('./package-collaborators.ts')
const { accessGrantCapability } = await import('./access-grants.ts')
const { authorize } = await import('#worker/authorization/authorize.ts')

let seed: PackageCollaboratorsSeed

beforeEach(async () => {
	seed = await seedPackageCollaborators()
	mocks.locked = new Set(['pkg-1'])
	mocks.resolveSavedPackage.mockReset()
	mocks.resolveSavedPackage.mockImplementation(
		async (input: { userId: string; packageIdOrKodyId: string }) =>
			seed.savedPackages.find(
				(savedPackage) =>
					savedPackage.userId === input.userId &&
					(savedPackage.id === input.packageIdOrKodyId ||
						savedPackage.kodyId === input.packageIdOrKodyId),
			) ?? null,
	)
})

function bobCanWrite() {
	const ctx = collaboratorCapabilityContext(seed, 'bob', 'member')
	return authorize(
		{ env: ctx.env, request: ctx.callerContext.request! },
		'package:write',
		{ type: 'package', id: 'pkg-1', orgId: ctx.callerContext.request!.org.id },
	).then(
		() => true,
		(error: Error) => error,
	)
}

test('granting Contribute on a package with unmappable credentials saves with a named warning', async () => {
	const result = await packageCollaboratorSetCapability.handler(
		{ package_id: 'demo-package', username: 'bob', preset: 'contribute' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	expect(result.collaborator.preset).toBe('contribute')
	expect(result.collaborator.allow_changes_despite_unmappable_credentials).toBe(
		false,
	)
	expect(result.warnings).toHaveLength(1)
	expect(result.warnings[0]).toContain('"Prod DB"')
	expect(result.warnings[0]).toContain("could make the package's code use them")
	const denied = await bobCanWrite()
	expect(denied).toBeInstanceOf(Error)
	expect((denied as Error).message).toContain('"Prod DB"')
})

test('Use grants and packages without unmappable credentials get no warning', async () => {
	const use = await packageCollaboratorSetCapability.handler(
		{ package_id: 'demo-package', username: 'bob', preset: 'use' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	expect(use.warnings).toEqual([])
	mocks.locked.clear()
	const contribute = await packageCollaboratorSetCapability.handler(
		{ package_id: 'demo-package', username: 'bob', preset: 'contribute' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	expect(contribute.warnings).toEqual([])
	expect(await bobCanWrite()).toBe(true)
})

test('an Owner can allow one collaborator to change it anyway, and turn it back off', async () => {
	const allowed = await packageCollaboratorSetCapability.handler(
		{
			package_id: 'demo-package',
			username: 'bob',
			preset: 'contribute',
			allow_changes_despite_unmappable_credentials: true,
		},
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	expect(
		allowed.collaborator.allow_changes_despite_unmappable_credentials,
	).toBe(true)
	expect(allowed.warnings[0]).toContain('This grant allows changes')
	expect(await bobCanWrite()).toBe(true)

	// Changing the preset keeps the choice; false turns it off.
	await packageCollaboratorSetCapability.handler(
		{ package_id: 'demo-package', username: 'bob', preset: 'manage' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	expect(await bobCanWrite()).toBe(true)
	await packageCollaboratorSetCapability.handler(
		{
			package_id: 'demo-package',
			username: 'bob',
			preset: 'manage',
			allow_changes_despite_unmappable_credentials: false,
		},
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	expect(await bobCanWrite()).toBeInstanceOf(Error)
})

test('only an org Owner can turn the allow option on', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	await expect(
		packageCollaboratorSetCapability.handler(
			{
				package_id: 'demo-package',
				username: 'bob',
				preset: 'contribute',
				allow_changes_despite_unmappable_credentials: true,
			},
			collaboratorCapabilityContext(seed, 'dan', null),
		),
	).rejects.toThrow(/Only an org Owner/)
})

test('existing write grants are locked with no grandfathering, and the list shows the notice', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-bob',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'use',
	})
	expect(await bobCanWrite()).toBeInstanceOf(Error)
	const list = await packageCollaboratorListCapability.handler(
		{ package_id: 'demo-package' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)
	const bob = list.collaborators.find((row) => row.grant_id === 'grant-bob')
	const designTeam = list.collaborators.find(
		(row) => row.grant_id === 'grant-team',
	)
	expect(bob?.unmappable_credential_warning).toContain('"Prod DB"')
	expect(designTeam?.unmappable_credential_warning).toBeNull()
	expect(list.unmappable_credentials?.notice).toContain(
		'changes are owner-only',
	)
	expect(JSON.stringify(list)).not.toContain('cred_')
})

test('accessGrant returns the same warning and accepts the allow option', async () => {
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	const result = await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: 'pkg-1',
			subject_type: 'team',
			team_slug: 'design',
			preset: 'contribute',
			allow_changes_despite_unmappable_credentials: true,
		},
		ctx,
	)
	expect(result.grant.allow_changes_despite_unmappable_credentials).toBe(true)
	expect(result.warnings[0]).toContain('"Prod DB"')
	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'package',
				resource_id: 'pkg-1',
				subject_type: 'org',
				preset: 'contribute',
				allow_changes_despite_unmappable_credentials: true,
			},
			ctx,
		),
	).rejects.toThrow(/per person or team/)
})
