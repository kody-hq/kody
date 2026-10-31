import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createdPackageResources,
	grantCreatorAccess,
} from './creator-access.ts'

const orgId = 'org-team'
const now = '2026-10-30T00:00:00.000Z'

function seed() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, 'team', ?, ?)`,
		)
		.run(orgId, now, now)
	for (const [userId, role] of [
		['person-owner', 'owner'],
		['person-member', 'member'],
	]) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
			)
			.run(orgId, userId!, role!, now)
	}
	const env = { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
	return { sqlite, env }
}

function liveGrants(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			`SELECT resource_type, resource_id, subject_type, subject_id, preset, origin
			 FROM grants WHERE deleted_at IS NULL ORDER BY resource_type`,
		)
		.all()
}

test('a member who creates a package gets manage on it and its app, once', async () => {
	const { sqlite, env } = seed()
	const input = {
		env,
		orgId,
		creatorUserId: 'person-member',
		resources: createdPackageResources('pkg-1'),
		audit: createTestOrgAuditWriter(),
	}
	expect(await grantCreatorAccess(input)).toEqual({ granted: 2 })
	expect(await grantCreatorAccess(input)).toEqual({ granted: 0 })
	expect(liveGrants(sqlite)).toEqual([
		{
			resource_type: 'app',
			resource_id: 'pkg-1',
			subject_type: 'user',
			subject_id: 'person-member',
			preset: 'manage',
			origin: 'created',
		},
		{
			resource_type: 'package',
			resource_id: 'pkg-1',
			subject_type: 'user',
			subject_id: 'person-member',
			preset: 'manage',
			origin: 'created',
		},
	])
})

test('owners, non-members, and unknown creators get no creator grant', async () => {
	const { sqlite, env } = seed()
	for (const creatorUserId of ['person-owner', 'person-outsider', null]) {
		expect(
			await grantCreatorAccess({
				env,
				orgId,
				creatorUserId,
				resources: createdPackageResources('pkg-1'),
				audit: createTestOrgAuditWriter(),
			}),
		).toEqual({ granted: 0 })
	}
	expect(liveGrants(sqlite)).toEqual([])
})

test('a credential creator grant carries the credential family', async () => {
	const { sqlite, env } = seed()
	await grantCreatorAccess({
		env,
		orgId,
		creatorUserId: 'person-member',
		resources: [
			{ resourceType: 'credential', resourceId: 'cred-1', family: 'secret' },
		],
		audit: createTestOrgAuditWriter(),
	})
	const permissions = sqlite
		.prepare(`SELECT permission FROM grant_permissions ORDER BY permission`)
		.all()
		.map((row) => row['permission'])
	expect(liveGrants(sqlite)).toEqual([
		expect.objectContaining({ resource_type: 'credential', origin: 'created' }),
	])
	expect(permissions).toContain('secret:use')
	expect(permissions).not.toContain('integration:use')
})

function seedProfile(
	sqlite: DatabaseSync,
	input: { id: string; actingUserId: string; revokedAt?: string | null },
) {
	sqlite
		.prepare(
			`INSERT INTO profiles (id, org_id, acting_user_id, name, depth, revoked_at,
				created_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			orgId,
			input.actingUserId,
			input.id,
			input.revokedAt ?? null,
			input.actingUserId,
			now,
			now,
		)
}

test('a profile that creates a package gets manage too, alongside its person', async () => {
	const { sqlite, env } = seed()
	seedProfile(sqlite, { id: 'prf-bot', actingUserId: 'person-member' })
	const input = {
		env,
		orgId,
		creatorUserId: 'person-member',
		creatorProfileId: 'prf-bot',
		resources: createdPackageResources('pkg-1'),
		audit: createTestOrgAuditWriter(),
	}
	expect(await grantCreatorAccess(input)).toEqual({ granted: 4 })
	expect(await grantCreatorAccess(input)).toEqual({ granted: 0 })
	const rows = liveGrants(sqlite) as Array<Record<string, string>>
	expect(
		rows
			.map((row) => `${row.resource_type}:${row.subject_type}:${row.origin}`)
			.sort(),
	).toEqual([
		'app:profile:created',
		'app:user:created',
		'package:profile:created',
		'package:user:created',
	])
})

test('an owner acting as a profile still grants the profile, never itself', async () => {
	const { sqlite, env } = seed()
	seedProfile(sqlite, { id: 'prf-owner-bot', actingUserId: 'person-owner' })
	expect(
		await grantCreatorAccess({
			env,
			orgId,
			creatorUserId: 'person-owner',
			creatorProfileId: 'prf-owner-bot',
			resources: createdPackageResources('pkg-1'),
			audit: createTestOrgAuditWriter(),
		}),
	).toEqual({ granted: 2 })
	const rows = liveGrants(sqlite) as Array<Record<string, string>>
	expect(rows.every((row) => row.subject_type === 'profile')).toBe(true)
})

test('a revoked or foreign profile gets no creator grant', async () => {
	const { sqlite, env } = seed()
	seedProfile(sqlite, {
		id: 'prf-gone',
		actingUserId: 'person-member',
		revokedAt: now,
	})
	seedProfile(sqlite, { id: 'prf-other', actingUserId: 'person-owner' })
	for (const creatorProfileId of ['prf-gone', 'prf-other', 'prf-missing']) {
		await grantCreatorAccess({
			env,
			orgId,
			creatorUserId: 'person-member',
			creatorProfileId,
			resources: createdPackageResources(`pkg-${creatorProfileId}`),
			audit: createTestOrgAuditWriter(),
		})
	}
	const rows = liveGrants(sqlite) as Array<Record<string, string>>
	expect(rows.some((row) => row.subject_type === 'profile')).toBe(false)
})
