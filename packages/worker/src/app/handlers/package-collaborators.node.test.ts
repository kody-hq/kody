import {
	grantPackageCollaboratorInput,
	revokePackageCollaboratorInput,
	createPackageCollaboratorInviteInput,
	revokePackageCollaboratorInviteInput,
} from '#universal/package-access-mutations.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import type * as PackageCollaboratorsRepo from '#worker/orgs/package-collaborators.ts'
import {
	type PackageCollaboratorsChange,
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
} from '#universal/package-collaborators.ts'
import {
	type CollaboratorPerson,
	collaboratorPeople,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'

const mocks = vi.hoisted(() => ({
	resolveSavedPackage: vi.fn(),
	failListReads: false,
	listReads: 0,
}))

vi.mock('#worker/orgs/package-collaborators.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageCollaboratorsRepo>()
	return {
		...actual,
		listPackageCollaborators: (
			...args: Parameters<typeof actual.listPackageCollaborators>
		) => {
			mocks.listReads++
			if (mocks.failListReads) throw new Error('Collaborators list unavailable')
			return actual.listPackageCollaborators(...args)
		},
		listPendingPackageInvites: (
			...args: Parameters<typeof actual.listPendingPackageInvites>
		) => {
			mocks.listReads++
			if (mocks.failListReads) throw new Error('Invites list unavailable')
			return actual.listPendingPackageInvites(...args)
		},
	}
})

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

const {
	readPackageCollaborators,
	grantPackageCollaborator,
	revokePackageCollaborator,
	createPackageCollaboratorInvite,
	revokePackageCollaboratorInvite,
} = await import('./package-collaborators.ts')

let seed: PackageCollaboratorsSeed

beforeEach(async () => {
	seed = await seedPackageCollaborators()
	mocks.failListReads = false
	mocks.listReads = 0
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

function signIn(person: CollaboratorPerson): AuthenticatedAppUser {
	const { id, personId } = collaboratorPeople[person]
	return {
		sessionUserId: personId,
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: person,
		roles: [],
		permissions: [],
		artifactOwnerIds: [personId],
		request: deriveRequestContext({
			user: { userId: personIdFromStored(personId), username: person },
			source: { kind: 'session' },
		}),
		userId: id,
		username: person,
		email: `${person}@example.com`,
		mcpUser: {
			userId: personIdFromStored(personId),
			username: person,
			email: `${person}@example.com`,
			displayName: person,
		},
	}
}

async function call(
	person: CollaboratorPerson,
	change?: PackageCollaboratorsChange,
	target = { username: 'zeta-co', kodyId: 'demo-package' },
) {
	const input = {
		user: signIn(person),
		request: new Request(
			'https://kody.test/@zeta-co/demo-package/collaborators',
		),
		env: { APP_DB: seed.db, AUDIT_DB: seed.auditDb } as Env,
		...target,
	}
	let result
	if (!change) result = await readPackageCollaborators(input)
	else {
		switch (change.intent) {
			case 'grant':
				result = await grantPackageCollaborator({
					...input,
					...grantPackageCollaboratorInput.parse({ ...input, ...change }),
				})
				break
			case 'revoke':
				result = await revokePackageCollaborator({
					...input,
					...revokePackageCollaboratorInput.parse({ ...input, ...change }),
				})
				break
			case 'invite':
				result = await createPackageCollaboratorInvite({
					...input,
					...createPackageCollaboratorInviteInput.parse({
						...input,
						...change,
					}),
				})
				break
			case 'revoke-invite':
				result = await revokePackageCollaboratorInvite({
					...input,
					...revokePackageCollaboratorInviteInput.parse({
						...input,
						...change,
					}),
				})
				break
		}
	}
	return {
		status: result.status,
		body: result.data as
			| PackageCollaboratorsWriteResult
			| PackageCollaboratorsView
			| { ok: false; error: string },
	}
}

function view(result: Awaited<ReturnType<typeof call>>) {
	if (!result.body.ok) throw new Error(result.body.error)
	if (!('package' in result.body))
		throw new Error('Expected a separate collaborators read.')
	return result.body
}

function acknowledgement(
	result: Awaited<ReturnType<typeof call>>,
): PackageCollaboratorsWriteResult {
	if (!result.body.ok) throw new Error(result.body.error)
	return result.body
}

async function changeAndRead(
	person: CollaboratorPerson,
	change: PackageCollaboratorsChange,
	target = { username: 'zeta-co', kodyId: 'demo-package' },
) {
	expect((await call(person, change, target)).body).toEqual({ ok: true })
	return view(await call(person, undefined, target))
}

async function auditActions() {
	const rows = await seed.auditDb
		.prepare(`SELECT action FROM org_audit_events ORDER BY created_at, rowid`)
		.all<{ action: string }>()
	return rows.results.map((row) => row.action)
}

test('an owner sees the teams and members they can add', async () => {
	const loaded = view(await call('ada'))
	expect(loaded.org).toEqual({ slug: 'zeta-co', personal: false })
	expect(loaded.collaborators).toEqual([])
	expect(loaded.options.teams.map((team) => team.slug)).toEqual(['design'])
	expect(loaded.options.members.map((member) => member.username)).toEqual([
		'bob',
	])
})

test('adding a team and a member, changing a preset, and removing are audited', async () => {
	const teamAdded = await changeAndRead('ada', {
		intent: 'grant',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'contribute',
	})
	expect(teamAdded.collaborators).toEqual([
		expect.objectContaining({
			kind: 'team',
			label: 'Design',
			preset: 'contribute',
		}),
	])
	expect(teamAdded.options.teams).toEqual([])

	await changeAndRead('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	const changed = await changeAndRead('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'manage',
	})
	const bob = changed.collaborators.find(
		(collaborator) => collaborator.username === 'bob',
	)
	expect(bob).toMatchObject({
		kind: 'member',
		label: '@bob',
		displayName: 'Bob Builder',
		preset: 'manage',
	})
	expect(changed.collaborators).toHaveLength(2)

	const removed = await changeAndRead('ada', {
		intent: 'revoke',
		grantId: bob!.grantId,
	})
	expect(removed.collaborators.map((row) => row.kind)).toEqual(['team'])

	expect(await auditActions()).toEqual([
		'grant.created',
		'grant.created',
		'grant.updated',
		'grant.revoked',
	])
})

test('a non-member cannot be added', async () => {
	const refused = await call('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(refused.status).toBe(400)
	expect(refused.body).toMatchObject({
		ok: false,
		error: /not a member of this organization/,
	})
	expect(await auditActions()).toEqual([])
})

test('an outside collaborator is listed and can be removed but not changed', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(view(await call('ada')).collaborators).toEqual([
		expect.objectContaining({ grantId: 'grant-dan', kind: 'outside' }),
	])
	const refused = await call('ada', {
		intent: 'grant',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'contribute',
	})
	expect(refused.status).toBe(400)
	const removed = await changeAndRead('ada', {
		intent: 'revoke',
		grantId: 'grant-dan',
	})
	expect(removed.collaborators).toEqual([])
	expect(await auditActions()).toEqual(['grant.revoked'])
})

test('grant input rejects invitation fields without a member or team identity', () => {
	expect(
		grantPackageCollaboratorInput.safeParse({
			username: 'zeta-co',
			kodyId: 'demo-package',
			intent: 'invite',
			invitee: '@dan',
			preset: 'use',
		}).success,
	).toBe(false)
})

test('a grant on another package cannot be removed here', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-other',
		packageId: 'pkg-2',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'use',
	})
	const revoke = await call('ada', { intent: 'revoke', grantId: 'grant-other' })
	expect(revoke.status).toBe(400)
	expect(revoke.body).toMatchObject({ error: /no longer has access/ })
	const live = await seed.db
		.prepare(`SELECT deleted_at FROM grants WHERE id = 'grant-other'`)
		.first<{ deleted_at: string | null }>()
	expect(live?.deleted_at).toBeNull()
})

test('Manage is required; without read the package is not found', async () => {
	insertCollaboratorGrant(seed, {
		id: 'grant-bob',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	const forbidden = await call('bob')
	expect(forbidden.status).toBe(403)
	expect(forbidden.body).toMatchObject({ ok: false, error: /Manage/ })
	const forbiddenWrite = await call('bob', {
		intent: 'revoke',
		grantId: 'grant-bob',
	})
	expect(forbiddenWrite.status).toBe(403)

	expect((await call('erin')).status).toBe(404)

	insertCollaboratorGrant(seed, {
		id: 'grant-dan',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'manage',
	})
	const outsideManager = view(await call('dan'))
	expect(outsideManager.collaborators.map((row) => row.username)).toEqual([
		'bob',
		'dan',
	])
})

test('a malformed grant is rejected', () => {
	expect(
		grantPackageCollaboratorInput.safeParse({
			username: 'zeta-co',
			kodyId: 'demo-package',
			subjectType: 'user',
		}).success,
	).toBe(false)
})

const personalPackage = { username: 'ada', kodyId: 'ada-tools' }

/** `ada-tools` in ada's personal org, resolvable by the mocked lookup. */
async function addPersonalPackage() {
	const org = await seed.db
		.prepare(`SELECT id FROM orgs WHERE slug = 'ada'`)
		.first<{ id: string }>()
	if (!org) throw new Error('ada has no personal org.')
	seed.savedPackages.push({
		id: 'pkg-ada',
		kodyId: 'ada-tools',
		name: 'ada-tools',
		userId: org.id,
	})
	return org.id
}

async function callPersonal(change?: PackageCollaboratorsChange) {
	return await call('ada', change, personalPackage)
}

test('invite changes are not accepted in a team org', async () => {
	const result = await call('ada', {
		intent: 'invite',
		invitee: '@dan',
		preset: 'use',
	})
	expect(result.status).toBe(400)
	expect(result.body).toMatchObject({ error: /personal organizations/ })
	const invites = await seed.db
		.prepare(`SELECT COUNT(*) AS count FROM invites`)
		.first<{ count: number }>()
	expect(invites?.count).toBe(0)
	const revoke = await call('ada', {
		intent: 'revoke-invite',
		inviteId: 'invite-1',
	})
	expect(revoke.status).toBe(400)
	expect(await auditActions()).toEqual([])
})

test('a personal org owner invites by username, sees it pending, and revokes it', async () => {
	await addPersonalPackage()
	const loaded = view(await callPersonal())
	expect(loaded.org).toEqual({ slug: 'ada', personal: true })
	expect(loaded.collaborators).toEqual([])
	expect(loaded.invites).toEqual([])

	const invited = acknowledgement(
		await callPersonal({
			intent: 'invite',
			invitee: '@dan',
			preset: 'contribute',
		}),
	)
	expect(invited.invite).toMatchObject({
		inviteeLabel: '@dan',
		preset: 'contribute',
		prompt: expect.stringMatching(/Call inviteAccept with this token: \w+/),
	})
	const pending = view(await callPersonal()).invites
	expect(pending).toEqual([
		expect.objectContaining({
			inviteeUsername: 'dan',
			inviteeEmail: null,
			preset: 'contribute',
		}),
	])
	expect(invited.invite?.id).toBe(pending[0]!.id)
	const stored = await seed.db
		.prepare(
			`SELECT kind, resource_type, resource_id, preset FROM invites WHERE id = ?`,
		)
		.bind(pending[0]!.id)
		.first()
	expect(stored).toEqual({
		kind: 'grant',
		resource_type: 'package',
		resource_id: 'pkg-ada',
		preset: 'contribute',
	})

	const reloaded = view(await callPersonal())
	expect(reloaded).not.toHaveProperty('invite')
	expect(reloaded.invites).toHaveLength(1)

	const revoked = acknowledgement(
		await callPersonal({
			intent: 'revoke-invite',
			inviteId: pending[0]!.id,
		}),
	)
	expect(revoked).toEqual({ ok: true })
	expect(view(await callPersonal()).invites).toEqual([])
	expect(await auditActions()).toEqual(['invite.created', 'invite.revoked'])

	const again = await callPersonal({
		intent: 'revoke-invite',
		inviteId: pending[0]!.id,
	})
	expect(again.status).toBe(404)
	expect(again.body).toMatchObject({ error: /no longer pending/ })
})

test('a personal invite takes an email, and refuses a malformed username', async () => {
	await addPersonalPackage()
	const invited = acknowledgement(
		await callPersonal({
			intent: 'invite',
			invitee: 'Jesse@Example.com',
			preset: 'use',
		}),
	)
	expect(invited.invite?.inviteeLabel).toBe('jesse@example.com')
	const pending = view(await callPersonal()).invites
	expect(pending).toEqual([
		expect.objectContaining({
			inviteeEmail: 'jesse@example.com',
			inviteeUsername: null,
			preset: 'use',
		}),
	])

	const refused = await callPersonal({
		intent: 'invite',
		invitee: 'not a username!',
		preset: 'use',
	})
	expect(refused.status).toBe(400)
	expect(view(await callPersonal()).invites).toHaveLength(1)
})

test('a pending invite on another package cannot be revoked here', async () => {
	await addPersonalPackage()
	const orgId = (await seed.db
		.prepare(`SELECT id FROM orgs WHERE slug = 'ada'`)
		.first<{ id: string }>())!.id
	seed.sqlite
		.prepare(
			`INSERT INTO invites (
			   id, org_id, kind, resource_type, resource_id, preset,
			   invitee_username, token_hash, status, invited_by_user_id,
			   expires_at, created_at
			 ) VALUES ('invite-other', ?, 'grant', 'package', 'pkg-elsewhere', 'use',
			   'dan', 'hash', 'pending', ?, '2999-01-01T00:00:00.000Z', ?)`,
		)
		.run(orgId, collaboratorPeople.ada.personId, new Date().toISOString())
	expect(view(await callPersonal()).invites).toEqual([])
	const refused = await callPersonal({
		intent: 'revoke-invite',
		inviteId: 'invite-other',
	})
	expect(refused.status).toBe(404)
	const status = await seed.db
		.prepare(`SELECT status FROM invites WHERE id = 'invite-other'`)
		.first<{ status: string }>()
	expect(status?.status).toBe('pending')
})

test('a personal org outside collaborator is listed and can be removed', async () => {
	const orgId = await addPersonalPackage()
	seed.sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-dan-personal', ?, 'package', 'pkg-ada', 'user', ?, 'use', ?, ?, ?)`,
		)
		.run(
			orgId,
			collaboratorPeople.dan.personId,
			collaboratorPeople.ada.personId,
			new Date().toISOString(),
			new Date().toISOString(),
		)
	seed.sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('grant-dan-personal', 'package:read'), ('grant-dan-personal', 'package:execute')`,
		)
		.run()
	expect(view(await callPersonal()).collaborators).toEqual([
		expect.objectContaining({
			grantId: 'grant-dan-personal',
			kind: 'outside',
			label: '@dan',
			preset: 'use',
		}),
	])
	const removed = await changeAndRead(
		'ada',
		{ intent: 'revoke', grantId: 'grant-dan-personal' },
		personalPackage,
	)
	expect(removed.collaborators).toEqual([])
	expect(await auditActions()).toEqual(['grant.revoked'])
})

test('a committed invite returns its one-time handoff even when confirming lists are unavailable', async () => {
	await addPersonalPackage()
	mocks.failListReads = true
	const created = acknowledgement(
		await callPersonal({ intent: 'invite', invitee: '@dan', preset: 'use' }),
	)
	expect(created).toEqual({
		ok: true,
		invite: expect.objectContaining({
			id: expect.any(String),
			prompt: expect.stringMatching(/Call inviteAccept with this token: \w+/),
		}),
	})
	expect(mocks.listReads).toBe(0)
	const id = created.invite!.id
	const stored = await seed.db
		.prepare('SELECT status FROM invites WHERE id = ?')
		.bind(id)
		.first()
	expect(stored).toEqual({ status: 'pending' })
	await expect(callPersonal()).rejects.toThrow('list unavailable')
	expect(mocks.listReads).toBeGreaterThan(0)
	mocks.listReads = 0
	expect(
		acknowledgement(
			await callPersonal({ intent: 'revoke-invite', inviteId: id }),
		),
	).toEqual({ ok: true })
	expect(mocks.listReads).toBe(0)
	expect(await auditActions()).toEqual(['invite.created', 'invite.revoked'])
})

test('collaborator grant and revoke acknowledgements do not depend on a confirming list', async () => {
	mocks.failListReads = true
	expect(
		acknowledgement(
			await call('ada', {
				intent: 'grant',
				subjectType: 'user',
				subjectId: collaboratorPeople.bob.personId,
				preset: 'use',
			}),
		),
	).toEqual({ ok: true })
	const grant = await seed.db
		.prepare('SELECT id FROM grants WHERE resource_id = ? AND subject_id = ?')
		.bind('pkg-1', collaboratorPeople.bob.personId)
		.first<{ id: string }>()
	expect(grant).not.toBeNull()
	expect(
		acknowledgement(
			await call('ada', { intent: 'revoke', grantId: grant!.id }),
		),
	).toEqual({ ok: true })
	expect(mocks.listReads).toBe(0)
	expect(await auditActions()).toEqual(['grant.created', 'grant.revoked'])
})

test('a personal package contributor and stranger cannot create or revoke addressed invites', async () => {
	const orgId = await addPersonalPackage()
	insertCollaboratorGrant(
		{ ...seed, orgId },
		{
			id: 'personal-contributor',
			packageId: 'pkg-ada',
			subjectType: 'user',
			subjectId: collaboratorPeople.bob.personId,
			preset: 'contribute',
		},
	)
	const created = acknowledgement(
		await callPersonal({ intent: 'invite', invitee: '@dan', preset: 'use' }),
	)
	for (const [person, status] of [
		['bob', 403],
		['erin', 404],
	] as const) {
		const create = await call(
			person,
			{ intent: 'invite', invitee: '@dan', preset: 'manage' },
			personalPackage,
		)
		expect(create.status).toBe(status)
		const revoke = await call(
			person,
			{ intent: 'revoke-invite', inviteId: created.invite!.id },
			personalPackage,
		)
		expect(revoke.status).toBe(status)
	}
	expect(
		await seed.db.prepare('SELECT COUNT(*) AS count FROM invites').first(),
	).toEqual({ count: 1 })
	expect(
		await seed.db
			.prepare('SELECT status FROM invites WHERE id = ?')
			.bind(created.invite!.id)
			.first(),
	).toEqual({ status: 'pending' })
	expect(await auditActions()).toEqual(['invite.created'])
})

test('pending package invites exclude expired, accepted, revoked, foreign and non-package records', async () => {
	const orgId = await addPersonalPackage()
	for (const row of [
		{
			id: 'live',
			orgId,
			kind: 'grant',
			type: 'package',
			resource: 'pkg-ada',
			status: 'pending',
			expires: '2999-01-01T00:00:00.000Z',
		},
		{
			id: 'expired',
			orgId,
			kind: 'grant',
			type: 'package',
			resource: 'pkg-ada',
			status: 'pending',
			expires: '2000-01-01T00:00:00.000Z',
		},
		{
			id: 'accepted',
			orgId,
			kind: 'grant',
			type: 'package',
			resource: 'pkg-ada',
			status: 'accepted',
			expires: '2999-01-01T00:00:00.000Z',
		},
		{
			id: 'revoked',
			orgId,
			kind: 'grant',
			type: 'package',
			resource: 'pkg-ada',
			status: 'revoked',
			expires: '2999-01-01T00:00:00.000Z',
		},
		{
			id: 'foreign-org',
			orgId: seed.orgId,
			kind: 'grant',
			type: 'package',
			resource: 'pkg-ada',
			status: 'pending',
			expires: '2999-01-01T00:00:00.000Z',
		},
		{
			id: 'other-package',
			orgId,
			kind: 'grant',
			type: 'package',
			resource: 'pkg-elsewhere',
			status: 'pending',
			expires: '2999-01-01T00:00:00.000Z',
		},
		{
			id: 'non-package',
			orgId,
			kind: 'grant',
			type: 'credential',
			resource: 'pkg-ada',
			status: 'pending',
			expires: '2999-01-01T00:00:00.000Z',
		},
		{
			id: 'membership',
			orgId,
			kind: 'membership',
			type: 'package',
			resource: 'pkg-ada',
			status: 'pending',
			expires: '2999-01-01T00:00:00.000Z',
		},
	]) {
		seed.sqlite
			.prepare(
				`INSERT INTO invites (id,org_id,kind,resource_type,resource_id,preset,invitee_username,token_hash,status,invited_by_user_id,expires_at,created_at) VALUES (?,?,?,?,?,'use','dan',?,?,?,?,'2026-01-01T00:00:00.000Z')`,
			)
			.run(
				row.id,
				row.orgId,
				row.kind,
				row.type,
				row.resource,
				`secret-hash-${row.id}`,
				row.status,
				collaboratorPeople.ada.personId,
				row.expires,
			)
	}
	const pending = view(await callPersonal()).invites
	expect(pending.map((invite) => invite.id)).toEqual(['live'])
	expect(pending[0]).not.toHaveProperty('token_hash')
	expect(pending[0]).not.toHaveProperty('prompt')
	expect(JSON.stringify(pending)).not.toContain('secret-hash')
})
