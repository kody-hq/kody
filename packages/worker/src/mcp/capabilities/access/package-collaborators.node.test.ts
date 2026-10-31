import { expect, test, vi } from 'vitest'
import {
	collaboratorCapabilityContext,
	collaboratorPeople,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

const mocks = vi.hoisted(() => ({ resolveSavedPackage: vi.fn() }))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

const {
	packageCollaboratorListCapability,
	packageCollaboratorRemoveCapability,
	packageCollaboratorSetCapability,
} = await import('./package-collaborators.ts')

async function createSeed(): Promise<PackageCollaboratorsSeed> {
	const seed = await seedPackageCollaborators()
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
	return seed
}

test('lists team, member, and outside collaborators', async () => {
	const seed = await createSeed()
	insertCollaboratorGrant(seed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'contribute',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-bob',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-other',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.erin.personId,
		preset: 'use',
	})
	const result = await packageCollaboratorListCapability.handler(
		{ package_id: 'demo-package' },
		collaboratorCapabilityContext(seed, 'ada', 'owner'),
	)

	expect(result.package).toEqual({
		id: 'pkg-1',
		kody_id: 'demo-package',
		name: 'demo-package',
	})
	expect(
		result.collaborators.map((collaborator) => ({
			grant_id: collaborator.grant_id,
			kind: collaborator.kind,
			username: collaborator.username,
			team_slug: collaborator.team_slug,
			preset: collaborator.preset,
		})),
	).toEqual([
		{
			grant_id: 'grant-team',
			kind: 'team',
			username: null,
			team_slug: 'design',
			preset: 'contribute',
		},
		{
			grant_id: 'grant-bob',
			kind: 'member',
			username: 'bob',
			team_slug: null,
			preset: 'use',
		},
		{
			grant_id: 'grant-dan',
			kind: 'outside',
			username: 'dan',
			team_slug: null,
			preset: 'manage',
		},
	])
})

test('an outside collaborator with Manage can list; Use cannot', async () => {
	const seed = await createSeed()
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-erin',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.erin.personId,
		preset: 'use',
	})

	const listed = await packageCollaboratorListCapability.handler(
		{ package_id: 'pkg-1' },
		collaboratorCapabilityContext(seed, 'dan', null),
	)
	expect(listed.collaborators.map((row) => row.username)).toEqual([
		'dan',
		'erin',
	])

	await expect(
		packageCollaboratorListCapability.handler(
			{ package_id: 'pkg-1' },
			collaboratorCapabilityContext(seed, 'erin', null),
		),
	).rejects.toThrow(/manage_access/)
})

async function auditActions(seed: PackageCollaboratorsSeed) {
	const rows = await seed.auditDb
		.prepare(`SELECT action FROM org_audit_events ORDER BY created_at, rowid`)
		.all<{ action: string }>()
	return rows.results.map((row) => row.action)
}

test('set adds a team and a member by slug and username, then changes a preset', async () => {
	const seed = await createSeed()
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	const team = await packageCollaboratorSetCapability.handler(
		{ package_id: 'demo-package', team_slug: 'design', preset: 'contribute' },
		ctx,
	)
	expect(team.collaborator).toMatchObject({
		kind: 'team',
		team_slug: 'design',
		team_name: 'Design',
		preset: 'contribute',
	})
	const member = await packageCollaboratorSetCapability.handler(
		{ package_id: 'pkg-1', username: 'bob', preset: 'use' },
		ctx,
	)
	expect(member.collaborator).toMatchObject({
		kind: 'member',
		username: 'bob',
		preset: 'use',
		permissions: ['package:execute', 'package:read'],
	})
	const changed = await packageCollaboratorSetCapability.handler(
		{ package_id: 'pkg-1', username: 'bob', preset: 'manage' },
		ctx,
	)
	expect(changed.collaborator).toMatchObject({
		grant_id: member.collaborator.grant_id,
		preset: 'manage',
	})
	const blankTeam = await packageCollaboratorSetCapability.handler(
		{ package_id: 'pkg-1', team_slug: '  ', username: ' bob ', preset: 'use' },
		ctx,
	)
	expect(blankTeam.collaborator).toMatchObject({
		kind: 'member',
		username: 'bob',
		preset: 'use',
	})
	expect(await auditActions(seed)).toEqual([
		'grant.created',
		'grant.created',
		'grant.updated',
		'grant.updated',
	])
})

test('set adds a person outside the org as an outside Read collaborator', async () => {
	const seed = await createSeed()
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	const result = await packageCollaboratorSetCapability.handler(
		{ package_id: 'pkg-1', username: 'dan', preset: 'read' },
		ctx,
	)
	expect(result.collaborator).toMatchObject({
		kind: 'outside',
		username: 'dan',
		preset: 'read',
		permissions: ['package:read'],
	})
})

test('set takes an advanced permission list instead of a preset', async () => {
	const seed = await createSeed()
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	const result = await packageCollaboratorSetCapability.handler(
		{
			package_id: 'pkg-1',
			username: 'dan',
			permissions: ['package:read', 'package:write'],
		},
		ctx,
	)
	expect(result.collaborator).toMatchObject({
		preset: null,
		permissions: ['package:read', 'package:write'],
	})
})

test('set refuses owners and ambiguous subjects', async () => {
	const seed = await createSeed()
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	await expect(
		packageCollaboratorSetCapability.handler(
			{ package_id: 'pkg-1', username: 'ada', preset: 'use' },
			ctx,
		),
	).rejects.toThrow(/Owners already have full access/)
	await expect(
		packageCollaboratorSetCapability.handler(
			{
				package_id: 'pkg-1',
				username: 'bob',
				team_slug: 'design',
				preset: 'use',
			},
			ctx,
		),
	).rejects.toThrow(/exactly one/)
	await expect(
		packageCollaboratorSetCapability.handler(
			{ package_id: 'pkg-1', preset: 'use' },
			ctx,
		),
	).rejects.toThrow(/exactly one/)
	await expect(
		packageCollaboratorSetCapability.handler(
			{
				package_id: 'pkg-1',
				username: 'dan',
				preset: 'manage',
				permissions: ['package:read'],
			},
			ctx,
		),
	).rejects.toThrow(/not both/)
	await expect(
		packageCollaboratorSetCapability.handler(
			{ package_id: 'pkg-1', user_id: 'no-such-user', preset: 'read' },
			ctx,
		),
	).rejects.toThrow(/No user with that user_id/)
	expect(await auditActions(seed)).toEqual([])
})

test('set and remove need manage access on the package', async () => {
	const seed = await createSeed()
	insertCollaboratorGrant(seed, {
		id: 'grant-bob',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	const bob = collaboratorCapabilityContext(seed, 'bob', 'member')
	await expect(
		packageCollaboratorSetCapability.handler(
			{ package_id: 'pkg-1', team_slug: 'design', preset: 'use' },
			bob,
		),
	).rejects.toThrow(/manage_access/)
	await expect(
		packageCollaboratorRemoveCapability.handler(
			{ package_id: 'pkg-1', grant_id: 'grant-bob' },
			bob,
		),
	).rejects.toThrow(/manage_access/)
})

test('remove revokes a grant on this package only', async () => {
	const seed = await createSeed()
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	insertCollaboratorGrant(seed, {
		id: 'grant-other',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	await expect(
		packageCollaboratorRemoveCapability.handler(
			{ package_id: 'pkg-1', grant_id: 'grant-other' },
			ctx,
		),
	).rejects.toThrow(/no longer has access to this package/)
	expect(
		await packageCollaboratorRemoveCapability.handler(
			{ package_id: 'demo-package', grant_id: 'grant-dan' },
			ctx,
		),
	).toEqual({ grant_id: 'grant-dan', removed: true })
	const listed = await packageCollaboratorListCapability.handler(
		{ package_id: 'pkg-1' },
		ctx,
	)
	expect(listed.collaborators).toEqual([])
	expect(await auditActions(seed)).toEqual(['grant.revoked'])
})
