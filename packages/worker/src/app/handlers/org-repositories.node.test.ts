import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

const { loadOrgRepositoriesData } = await import('../org-repositories-data.ts')
const { loadOrgBindingForSlug } = await import('#worker/orgs/repo.ts')

const ownerId = 'person-owner'
const memberId = 'person-member'
const guestId = 'person-guest'
const teamId = 'org-acme'
const now = '2026-01-01T00:00:00.000Z'

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	insertOrg.run(teamId, 'acme', 'Acme', now, now)
	for (const [id, slug] of [
		[ownerId, 'owner'],
		[memberId, 'member'],
		[guestId, 'guest'],
	] as const) {
		insertOrg.run(id, slug, slug, now, now)
	}
	const insertMembership = sqlite.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
	insertMembership.run(teamId, ownerId, 'owner', now)
	insertMembership.run(teamId, memberId, 'member', now)
	const insertPackage = sqlite.prepare(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		 VALUES (?, ?, ?, ?, 'pkg', ?)`,
	)
	insertPackage.run('pkg-shared', teamId, '@acme/shared', 'shared', 'src-1')
	insertPackage.run('pkg-secret', teamId, '@acme/secret', 'secret', 'src-2')
	insertPackage.run('pkg-mine', memberId, '@member/mine', 'mine', 'src-3')
	sqlite
		.prepare(
			`INSERT INTO user_repos (id, user_id, name, description, is_private, created_at, updated_at)
			 VALUES (?, ?, ?, 'plain repo', 1, ?, ?)`,
		)
		.run('repo-notes', teamId, 'plain-notes', now, now)
	sqlite
		.prepare(`UPDATE saved_packages SET updated_at = ? WHERE id = ?`)
		.run('2030-01-01T00:00:00.000Z', 'pkg-secret')
	const insertGrant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, ?, 'package', ?, 'user', ?, 'use', ?, ?, ?, NULL)`,
	)
	const insertPermission = sqlite.prepare(
		`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
	)
	for (const [grantId, subjectId] of [
		['grant-member', memberId],
		['grant-guest', guestId],
	] as const) {
		insertGrant.run(grantId, teamId, 'pkg-shared', subjectId, ownerId, now, now)
		insertPermission.run(grantId, 'package:read')
		insertPermission.run(grantId, 'package:execute')
	}
	// Execute-only without a listing: listed via canSeeResource, but the owner
	// package page needs read, so the name stays unlinked.
	insertPackage.run('pkg-run', teamId, '@acme/run', 'run', 'src-4')
	insertGrant.run(
		'grant-member-run',
		teamId,
		'pkg-run',
		memberId,
		ownerId,
		now,
		now,
	)
	insertPermission.run('grant-member-run', 'package:execute')
	// Execute-only with a public listing: the canonical URL resolves without
	// package:read, so the name still links.
	insertPackage.run('pkg-listed', teamId, '@acme/listed', 'listed', 'src-5')
	insertGrant.run(
		'grant-member-listed',
		teamId,
		'pkg-listed',
		memberId,
		ownerId,
		now,
		now,
	)
	insertPermission.run('grant-member-listed', 'package:execute')
	sqlite
		.prepare(
			`INSERT INTO community_listings (
				id, owner_user_id, package_id, source_id, kody_id, name, description,
				tags_json, license, pinned_commit, status, created_at, updated_at, published_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		)
		.run(
			'listing-listed',
			teamId,
			'pkg-listed',
			'src-5',
			'listed',
			'@acme/listed',
			'listed description',
			'[]',
			'MIT',
			'commit-1',
			now,
			now,
			now,
		)
	return {
		APP_DB: createD1FromSqlite(sqlite),
		JOBS: undefined,
	} as unknown as Env
}

async function listAs(env: Env, personId: string, search = '') {
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		username: personId,
		mcpUser: { userId: personId, username: personId },
	})
	const params = new URLSearchParams(search)
	const parsedLimit = Number.parseInt(params.get('limit') ?? '', 10)
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		personId as never,
		'acme',
	)
	const user = await mocks.readAuthenticatedAppUser()
	const data = binding?.role
		? await loadOrgRepositoriesData({
				env,
				user,
				binding,
				query: params.get('q') ?? '',
				limit:
					Number.isFinite(parsedLimit) && parsedLimit > 0
						? Math.min(parsedLimit, 100)
						: undefined,
			})
		: { ok: false, error: 'Not found.' }

	return {
		status: binding?.role ? 200 : 404,
		body: data as {
			ok: boolean
			error?: string
			activity?: Array<unknown> | null
			packages?: Array<{
				kodyId: string
				isPrivate?: boolean
				canOpenDetail?: boolean
				hasPackage?: boolean
			}>
			profile?: { username: string; displayName: string }
		},
	}
}

test('team repositories list what each member role can see', async () => {
	const env = createEnv()

	const owner = await listAs(env, ownerId)
	expect(owner.status).toBe(200)
	expect(owner.body.profile).toMatchObject({
		username: 'acme',
		displayName: 'Acme',
	})
	expect(owner.body.activity).toBeNull()
	expect(owner.body.packages?.map((pkg) => pkg.kodyId).sort()).toEqual([
		'listed',
		'plain-notes',
		'run',
		'secret',
		'shared',
	])
	expect(
		owner.body.packages?.find((pkg) => pkg.kodyId === 'plain-notes'),
	).toMatchObject({ hasPackage: false })
	expect(owner.body.packages?.every((pkg) => pkg.canOpenDetail !== false)).toBe(
		true,
	)

	const member = await listAs(env, memberId)
	expect(member.status).toBe(200)
	expect(
		new Map(
			member.body.packages?.map((pkg) => [
				pkg.kodyId,
				{ canOpenDetail: pkg.canOpenDetail, hasPackage: pkg.hasPackage },
			]),
		),
	).toEqual(
		new Map([
			// Execute-only + public listing → link (canonical URL resolves).
			['listed', { canOpenDetail: undefined, hasPackage: true }],
			// Plain repos have no grant surface; every member sees them.
			['plain-notes', { canOpenDetail: undefined, hasPackage: false }],
			// Execute-only, no listing → no link (owner page needs package:read).
			['run', { canOpenDetail: false, hasPackage: true }],
			['shared', { canOpenDetail: undefined, hasPackage: true }],
		]),
	)

	// The newest org package is one the member cannot see. The cap applies
	// after the visibility filter, so it does not crowd out theirs.
	const capped = await listAs(env, memberId, '?limit=1')
	expect(capped.body.packages?.map((pkg) => pkg.kodyId)).toEqual(['listed'])
	const ownerCapped = await listAs(env, ownerId, '?limit=1')
	expect(ownerCapped.body.packages?.map((pkg) => pkg.kodyId)).toEqual([
		'secret',
	])

	// A grant-only collaborator is not a member of the workspace.
	const guest = await listAs(env, guestId)
	expect(guest.status).toBe(404)
	expect(guest.body).toEqual({
		ok: false,
		error: 'Not found.',
	})
})
