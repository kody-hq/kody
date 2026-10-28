import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { addOrgMember, upsertGrant } from '#worker/orgs/access-writes.ts'
import { listMemoryReadersForOrgMemory } from '#worker/mcp/memory/memory-personalize.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import {
	collaboratorCapabilityContext,
	collaboratorPeople,
	collaboratorsNow,
	type CollaboratorPerson,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'
import {
	bumpAccessEpochStatement,
	compileAccessForRequest,
} from './access-compile.ts'

const mocks = vi.hoisted(() => ({ resolveSavedPackage: vi.fn() }))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

const { accessGrantCapability } =
	await import('#mcp/capabilities/access/access-grants.ts')
const { packageCollaboratorListCapability, packageCollaboratorSetCapability } =
	await import('#mcp/capabilities/access/package-collaborators.ts')

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

function grantEveryone(seed: PackageCollaboratorsSeed, packageId = 'pkg-1') {
	insertCollaboratorGrant(seed, {
		id: `grant-everyone-${packageId}`,
		packageId,
		subjectType: 'org',
		subjectId: seed.orgId,
		preset: 'use',
	})
}

/** Package permissions `person` holds on `packageId`, through a fresh compile. */
async function packagePermissions(
	seed: PackageCollaboratorsSeed,
	person: CollaboratorPerson,
	role: OrgRole | null,
	packageId = 'pkg-1',
) {
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(collaboratorPeople[person].personId),
			username: person,
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(seed.orgId), slug: 'zeta-co' },
			role,
		},
	})
	const compiled = await compileAccessForRequest({ db: seed.db, request })
	return [
		...(compiled.resourcePermissions.get(`package:${packageId}`) ?? []),
	].sort()
}

async function leaveOrg(
	seed: PackageCollaboratorsSeed,
	person: CollaboratorPerson,
) {
	await seed.db.batch([
		seed.db
			.prepare(
				`UPDATE org_memberships SET deleted_at = ?
				 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(collaboratorsNow, seed.orgId, collaboratorPeople[person].personId),
		bumpAccessEpochStatement(seed.db, seed.orgId),
	])
}

test('everyone in the org gets the grant on that one package only', async () => {
	const seed = await createSeed()
	grantEveryone(seed)

	expect(await packagePermissions(seed, 'bob', 'member')).toEqual([
		'package:execute',
		'package:read',
	])
	expect(await packagePermissions(seed, 'bob', 'member', 'pkg-2')).toEqual([])
	// Not a member: the package stays private.
	expect(await packagePermissions(seed, 'dan', null)).toEqual([])
})

test('a member who leaves the org loses access at once', async () => {
	const seed = await createSeed()
	grantEveryone(seed)
	expect(await packagePermissions(seed, 'bob', 'member')).toContain(
		'package:read',
	)

	await leaveOrg(seed, 'bob')

	// Even a stale member binding finds nothing: membership is checked live.
	expect(await packagePermissions(seed, 'bob', 'member')).toEqual([])
	expect(await packagePermissions(seed, 'bob', null)).toEqual([])
	const grantRows = await seed.db
		.prepare(
			`SELECT COUNT(*) AS n FROM grants WHERE subject_type = 'org' AND deleted_at IS NULL`,
		)
		.first<{ n: number }>()
	expect(grantRows?.n).toBe(1)
})

test('a member who joins later gains access without a new grant', async () => {
	const seed = await createSeed()
	grantEveryone(seed)
	expect(await packagePermissions(seed, 'erin', null)).toEqual([])

	await addOrgMember({
		db: seed.db,
		orgId: seed.orgId,
		userId: collaboratorPeople.erin.personId,
		role: 'member',
		invitedByUserId: collaboratorPeople.ada.personId,
		audit: createTestOrgAuditWriter(),
	})

	expect(await packagePermissions(seed, 'erin', 'member')).toEqual([
		'package:execute',
		'package:read',
	])
	const grantCount = await seed.db
		.prepare(`SELECT COUNT(*) AS n FROM grants WHERE deleted_at IS NULL`)
		.first<{ n: number }>()
	expect(grantCount?.n).toBe(1)
})

test('accessGrant grants everyone in the bound org and refuses other orgs', async () => {
	const seed = await createSeed()
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')

	const granted = await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: 'pkg-1',
			subject_type: 'org',
			preset: 'use',
		},
		ctx,
	)
	expect(granted.grant).toMatchObject({
		subject_type: 'org',
		subject_id: seed.orgId,
		preset: 'use',
	})

	const otherOrgId = collaboratorPeople.dan.personId
	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'package',
				resource_id: 'pkg-1',
				subject_type: 'org',
				subject_id: otherOrgId,
				preset: 'use',
			},
			ctx,
		),
	).rejects.toThrow(/organization this request is bound to/)
	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'package',
				resource_id: 'pkg-1',
				subject_type: 'org',
				username: 'dan',
				preset: 'use',
			},
			ctx,
		),
	).rejects.toThrow(/omit username/)
	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'org',
				resource_id: seed.orgId,
				subject_type: 'org',
				permissions: ['package:read'],
			},
			ctx,
		),
	).rejects.toThrow(/cannot target resource_type org/)
})

test('the grant store and schema refuse an everyone grant naming another org', async () => {
	const seed = await createSeed()
	await expect(
		upsertGrant({
			db: seed.db,
			orgId: seed.orgId,
			resourceType: 'package',
			resourceId: 'pkg-1',
			subject: { type: 'org', id: collaboratorPeople.dan.personId },
			preset: 'use',
			permissions: null,
			createdByUserId: collaboratorPeople.ada.personId,
			audit: createTestOrgAuditWriter(),
		}),
	).rejects.toThrow(/must name the organization/)
})

test('packageCollaboratorSet adds everyone; the list shows it first', async () => {
	const seed = await createSeed()
	insertCollaboratorGrant(seed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'contribute',
	})
	const ctx = collaboratorCapabilityContext(seed, 'ada', 'owner')
	const set = await packageCollaboratorSetCapability.handler(
		{ package_id: 'demo-package', everyone: true, preset: 'use' },
		ctx,
	)
	expect(set.collaborator).toMatchObject({
		subject_type: 'org',
		subject_id: seed.orgId,
		kind: 'org',
		preset: 'use',
	})
	await expect(
		packageCollaboratorSetCapability.handler(
			{
				package_id: 'demo-package',
				everyone: true,
				username: 'bob',
				preset: 'use',
			},
			ctx,
		),
	).rejects.toThrow(/exactly one of/)

	const listed = await packageCollaboratorListCapability.handler(
		{ package_id: 'demo-package' },
		ctx,
	)
	expect(listed.collaborators.map((row) => row.kind)).toEqual(['org', 'team'])
})

test('the existing everyone team plus invite-link default still grants new members', async () => {
	const seed = await createSeed()
	// The interim workaround: a team with Use, which invite links add people to.
	insertCollaboratorGrant(seed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'use',
	})
	await addOrgMember({
		db: seed.db,
		orgId: seed.orgId,
		userId: collaboratorPeople.erin.personId,
		role: 'member',
		invitedByUserId: collaboratorPeople.ada.personId,
		audit: createTestOrgAuditWriter(),
	})
	expect(await packagePermissions(seed, 'erin', 'member')).toEqual([])
	seed.sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at) VALUES ('team-design', ?, ?)`,
		)
		.run(collaboratorPeople.erin.personId, collaboratorsNow)
	await seed.db.batch([bumpAccessEpochStatement(seed.db, seed.orgId)])
	expect(await packagePermissions(seed, 'erin', 'member')).toEqual([
		'package:execute',
		'package:read',
	])
})

test('memory readers expand an everyone grant to live members', async () => {
	const seed = await createSeed()
	seed.sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-memory', ?, 'memory', 'mem-1', 'org', ?, NULL, ?, ?, ?)`,
		)
		.run(
			seed.orgId,
			seed.orgId,
			collaboratorPeople.ada.personId,
			collaboratorsNow,
			collaboratorsNow,
		)
	seed.sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('grant-memory', 'memory:read')`,
		)
		.run()
	const readers = async () =>
		(
			await listMemoryReadersForOrgMemory({
				db: seed.db,
				orgId: seed.orgId,
				memoryId: 'mem-1',
			})
		)
			.map(String)
			.sort()
	expect(await readers()).toEqual(
		[collaboratorPeople.ada.personId, collaboratorPeople.bob.personId].sort(),
	)
	await leaveOrg(seed, 'bob')
	expect(await readers()).toEqual([collaboratorPeople.ada.personId])
})
