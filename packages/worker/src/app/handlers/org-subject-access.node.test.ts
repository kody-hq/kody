import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { resolveOrgManagementAccess } from '#app/org-management-access.ts'
import { revokeOrganizationGrants } from './org-grants.ts'
import {
	grantOrganizationSubjectAccess,
	loadOrgSubjectAccessData,
	parseOrgAccessSubjectKey,
} from './org-subject-access.ts'

const now = '2026-10-13T00:00:00.000Z'
const people = ['bea', 'ann', 'cy', 'dee'] as const
type Person = (typeof people)[number]

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const ids = Object.fromEntries(
		people.map((username) => [
			username,
			testStableUserIdFromEmail(`${username}@example.com`),
		]),
	) as Record<Person, string>
	for (const [index, username] of people.entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				ids[username],
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: ids[username],
			username,
			createdAt: now,
		})
	}
	// Bea owns the org; Ann is a member; Cy holds a grant only; Dee is a stranger.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(ids.bea),
			audit: createTestOrgAuditWriter(),
			slug: 'work-co',
			displayName: 'Work Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const orgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'work-co'`)
		.first<{ id: string }>())!.id
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(orgId, ids.ann, now)
	for (const [id, name, hasApp] of [
		['pkg-inbox', 'Work inbox', 1],
		['pkg-deploy', 'Deploy bot', 0],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, has_app, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
			)
			.run(id, orgId, name, id, `source-${id}`, hasApp, now, now)
	}
	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at)
			 VALUES ('grant-cy', ?, 'package', 'pkg-deploy', 'user', ?, 'use', ?, ?, ?)`,
		)
		.run(orgId, ids.cy, ids.bea, now, now)
	await saveSecret({
		env,
		userId: ownerIdFromStored(orgId),
		scope: 'user',
		name: 'workToken',
		value: 'v',
		audit: null,
	})
	const tokenId = (
		await findCredentialIdsByLegacyName(db, orgId, {
			type: 'secret',
			name: 'workToken',
		})
	)[0]!
	const signIn = async (person: Person) => {
		const binding = (await loadOrgBindingForSlug(db, ids[person], 'work-co'))!
		const mcpUser = {
			userId: personIdFromStored(ids[person]),
			username: person,
			email: `${person}@example.com`,
			displayName: person,
		}
		return {
			userId: people.indexOf(person) + 1,
			username: person,
			email: `${person}@example.com`,
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding: binding,
			}),
		} as AuthenticatedAppUser
	}
	const request = new Request('https://kody.test/@work-co/-/grants')
	const load = async (viewer: Person, subject: Person) => {
		const user = await signIn(viewer)
		const access = await resolveOrgManagementAccess({
			env,
			request,
			user,
			orgSlug: 'work-co',
			permission: 'member:read',
		})
		if (!access.ok) throw new Error(access.error)
		return loadOrgSubjectAccessData({
			env,
			user,
			org: access.org,
			userId: ids[subject],
		})
	}
	const grant = async (
		viewer: Person,
		subject: Person,
		items: Parameters<typeof grantOrganizationSubjectAccess>[0]['items'],
	) =>
		grantOrganizationSubjectAccess({
			request,
			env,
			user: await signIn(viewer),
			orgSlug: 'work-co',
			userId: ids[subject],
			items,
		})
	const loadSubject = async (viewer: Person, key: string) => {
		const user = await signIn(viewer)
		const access = await resolveOrgManagementAccess({
			env,
			request,
			user,
			orgSlug: 'work-co',
			permission: 'member:read',
		})
		if (!access.ok) throw new Error(access.error)
		const subject = parseOrgAccessSubjectKey(key)
		if (!subject) throw new Error(`bad subject ${key}`)
		return loadOrgSubjectAccessData({ env, user, org: access.org, subject })
	}
	const grantTo = async (
		viewer: Person,
		subject: string,
		items: Parameters<typeof grantOrganizationSubjectAccess>[0]['items'],
	) =>
		grantOrganizationSubjectAccess({
			request,
			env,
			user: await signIn(viewer),
			orgSlug: 'work-co',
			subject,
			items,
		})
	const revokeMany = async (viewer: Person, grantIds: Array<string>) =>
		revokeOrganizationGrants({
			request,
			env,
			user: await signIn(viewer),
			orgSlug: 'work-co',
			grantIds,
		})
	return {
		ids,
		tokenId,
		orgId,
		sqlite,
		load,
		grant,
		loadSubject,
		grantTo,
		revokeMany,
	}
}

test('an Owner gives a member several packages, an app, and a credential in one save', async () => {
	const { load, grant, tokenId } = await setup()
	const before = await load('bea', 'ann')
	expect(before?.subject).toMatchObject({ username: 'ann', role: 'member' })
	expect(before?.grants).toEqual([])
	expect(before?.options?.packages).toEqual([
		expect.objectContaining({ resourceId: 'pkg-deploy', appGrantable: false }),
		expect.objectContaining({ resourceId: 'pkg-inbox', appGrantable: true }),
	])
	expect(before?.options?.credentials).toEqual([
		expect.objectContaining({ resourceId: tokenId, label: 'workToken' }),
	])

	const saved = await grant('bea', 'ann', [
		{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
		{ resourceType: 'app', resourceId: 'pkg-inbox', preset: 'use' },
		{ resourceType: 'credential', resourceId: tokenId, preset: 'use' },
		{ resourceType: 'credential', resourceId: 'missing', preset: 'use' },
	])
	expect(saved.status).toBe(200)
	const results = (saved.data as { results: Array<{ ok: boolean }> }).results
	expect(results.map((result) => result.ok)).toEqual([true, true, true, false])

	const after = await load('bea', 'ann')
	expect(
		after?.grants
			.map((entry) => [
				entry.resourceType,
				entry.resourceLabel,
				entry.presetLabel,
				entry.via,
				entry.canRevoke,
			])
			.sort(),
	).toEqual([
		['app', 'Work inbox', 'Use', 'direct', true],
		['credential', 'Secret workToken', 'Use', 'direct', true],
		['package', 'Work inbox', 'Use', 'direct', true],
	])
	expect(after?.options?.packages.map((option) => option.resourceId)).toEqual([
		'pkg-deploy',
	])
	expect(after?.options?.credentials).toEqual([])

	// Changing a preset is the same upsert.
	await grant('bea', 'ann', [
		{ resourceType: 'credential', resourceId: tokenId, preset: 'manage' },
	])
	const changed = await load('bea', 'ann')
	expect(
		changed?.grants.find((entry) => entry.resourceType === 'credential'),
	).toMatchObject({ presetLabel: 'Manage' })
})

test('an outside collaborator with a grant has a page; a stranger and an Owner do not take grants', async () => {
	const { load, grant } = await setup()
	const cy = await load('bea', 'cy')
	expect(cy?.subject).toMatchObject({ kind: 'user', role: null })
	expect(cy?.grants).toEqual([
		expect.objectContaining({ id: 'grant-cy', via: 'direct' }),
	])
	expect(await load('bea', 'dee')).toBeNull()

	const stranger = await grant('bea', 'dee', [
		{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
	])
	expect(stranger.status).toBe(400)
	const owner = await grant('bea', 'bea', [
		{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
	])
	expect(owner.status).toBe(400)
	expect((await load('bea', 'bea'))?.options).toBeNull()
})

test('a member without member:write sees access read-only and cannot grant', async () => {
	const { load, grant } = await setup()
	const view = await load('ann', 'cy')
	expect(view?.canManage).toBe(false)
	expect(view?.options).toBeNull()
	expect(view?.grants.every((entry) => !entry.canRevoke)).toBe(true)
	const denied = await grant('ann', 'cy', [
		{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
	])
	expect(denied.status).toBe(403)
})

test('an Owner gives a team access, sees everyone grants as inherited, and bulk revokes', async () => {
	const { ids, tokenId, orgId, sqlite, loadSubject, grantTo, revokeMany } =
		await setup()
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-ops', ?, 'ops', 'Ops', ?, ?)`,
		)
		.run(orgId, now, now)
	sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at) VALUES ('team-ops', ?, ?)`,
		)
		.run(ids.ann, now)
	sqlite
		.prepare(
			`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id, preset, created_by_user_id, created_at, updated_at)
			 VALUES ('grant-everyone', ?, 'package', 'pkg-deploy', 'org', ?, 'use', ?, ?, ?)`,
		)
		.run(orgId, orgId, ids.bea, now, now)

	const saved = await grantTo('bea', 'team:team-ops', [
		{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
		{ resourceType: 'app', resourceId: 'pkg-inbox', preset: 'use' },
		{ resourceType: 'credential', resourceId: tokenId, preset: 'use' },
	])
	expect(saved.status).toBe(200)

	const team = await loadSubject('bea', 'team:team-ops')
	expect(team?.subject).toMatchObject({
		kind: 'team',
		teamId: 'team-ops',
		slug: 'ops',
		name: 'Ops',
		memberCount: 1,
	})
	expect(team?.canManage).toBe(true)
	const direct = team!.grants.filter((entry) => entry.via === 'direct')
	expect(direct.map((entry) => entry.resourceType).sort()).toEqual([
		'app',
		'credential',
		'package',
	])
	expect(direct.every((entry) => entry.canRevoke)).toBe(true)
	expect(team?.grants).toContainEqual(
		expect.objectContaining({
			id: 'grant-everyone',
			via: 'everyone',
			canRevoke: false,
		}),
	)

	// Ann, a team member, inherits the team grants on her own page.
	const ann = await loadSubject('bea', `user:${ids.ann}`)
	expect(
		ann?.grants
			.filter((entry) => entry.via === 'team')
			.map((entry) => entry.id),
	).toEqual(expect.arrayContaining(direct.map((entry) => entry.id)))

	const everyone = await loadSubject('bea', 'org')
	expect(everyone?.subject).toEqual({ kind: 'org', memberCount: 2 })
	expect(everyone?.grants).toEqual([
		expect.objectContaining({ id: 'grant-everyone', via: 'direct' }),
	])

	const revoked = await revokeMany('bea', [
		...direct.map((entry) => entry.id),
		'grant-missing',
	])
	expect(revoked.status).toBe(200)
	if (!revoked.data.ok) throw new Error(revoked.data.error)
	const body = revoked.data
	expect(body.results.filter((entry) => entry.ok)).toHaveLength(3)
	expect(body.results).toContainEqual(
		expect.objectContaining({ grantId: 'grant-missing', ok: false }),
	)
	const after = await loadSubject('bea', 'team:team-ops')
	expect(after?.grants.filter((entry) => entry.via === 'direct')).toEqual([])
})

test('a member cannot grant to a team or bulk revoke, and unknown teams have no page', async () => {
	const { orgId, sqlite, loadSubject, grantTo, revokeMany } = await setup()
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-ops', ?, 'ops', 'Ops', ?, ?)`,
		)
		.run(orgId, now, now)
	expect(await loadSubject('bea', 'team:team-missing')).toBeNull()
	const view = await loadSubject('ann', 'team:team-ops')
	expect(view?.canManage).toBe(false)
	expect(view?.options).toBeNull()
	const denied = await grantTo('ann', 'team:team-ops', [
		{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
	])
	expect(denied.status).toBe(403)
	const deniedBulk = await revokeMany('ann', ['grant-cy'])
	expect(deniedBulk.status).toBe(403)
	expect(
		(
			await grantTo('bea', 'team:team-missing', [
				{ resourceType: 'package', resourceId: 'pkg-inbox', preset: 'use' },
			])
		).status,
	).toBe(400)
})
