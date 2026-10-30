import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { runCreatorAccessBackfill } from './creator-access-backfill.ts'

const orgId = 'org-team'
const now = '2026-10-30T00:00:00.000Z'

function seed() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const run = (sql: string, ...params: Array<string | null>) =>
		sqlite.prepare(sql).run(...params)
	run(
		`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, 'team', ?, ?)`,
		orgId,
		now,
		now,
	)
	for (const [userId, role, deletedAt] of [
		['person-owner', 'owner', null],
		['person-member', 'member', null],
		['person-left', 'member', now],
	] as const) {
		run(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)`,
			orgId,
			userId,
			role,
			now,
			deletedAt,
		)
	}
	for (const [id, deletedAt] of [
		['pkg-member', null],
		['pkg-owner', null],
		['pkg-left', null],
		['pkg-deleted', now],
		['pkg-revoked', null],
	] as const) {
		run(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, deleted_at)
			 VALUES (?, ?, ?, ?, 'desc', ?, ?)`,
			id,
			orgId,
			`@team/${id}`,
			id,
			`src-${id}`,
			deletedAt,
		)
	}
	run(
		`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at)
		 VALUES ('grant-revoked', ?, 'package', 'pkg-revoked', 'user', 'person-member',
			'use', 'person-owner', ?, ?, ?)`,
		orgId,
		now,
		now,
		now,
	)
	const auditDb = createAuditTestDb()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: auditDb,
	} as unknown as Env
	return { sqlite, env, auditDb }
}

async function insertAudit(
	auditDb: D1Database,
	rows: Array<{
		actor: string
		action: string
		resourceId: string
		details: Record<string, unknown>
	}>,
) {
	let index = 0
	for (const row of rows) {
		index += 1
		await auditDb
			.prepare(
				`INSERT INTO org_audit_events (id, org_id, actor_user_id, action, resource_type, resource_id, result, details_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?)`,
			)
			.bind(
				`audit-${index}`,
				orgId,
				row.actor,
				row.action,
				row.action === 'credential.created' ? 'credential' : 'package',
				row.resourceId,
				JSON.stringify(row.details),
				`2026-10-0${index}T00:00:00.000Z`,
			)
			.run()
	}
}

test('dry run counts, apply writes creator grants once, and reruns are no-ops', async () => {
	const { sqlite, env, auditDb } = seed()
	const published = (actor: string, resourceId: string, first = true) => ({
		actor,
		action: 'package.published',
		resourceId,
		details: { firstPublish: first },
	})
	await insertAudit(auditDb, [
		published('person-member', 'pkg-member'),
		// A later publish by someone else never changes the creator.
		published('person-owner', 'pkg-member', false),
		published('person-owner', 'pkg-owner'),
		published('person-left', 'pkg-left'),
		published('person-member', 'pkg-deleted'),
		published('person-member', 'pkg-revoked'),
	])
	const dryRun = await runCreatorAccessBackfill({
		env,
		dryRun: true,
		audit: null,
		afterOrgId: null,
	})
	expect(dryRun).toMatchObject({
		orgsScanned: 1,
		would_grant: 3,
		granted: 0,
		creator_is_owner: 2,
		creator_not_member: 2,
		resource_gone: 1,
		previously_revoked: 1,
		nextCursor: null,
	})
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS n FROM grants WHERE deleted_at IS NULL`)
			.get(),
	).toEqual({ n: 0 })

	const applied = await runCreatorAccessBackfill({
		env,
		dryRun: false,
		audit: createTestOrgAuditWriter({ db: auditDb, appDb: env.APP_DB }),
		afterOrgId: null,
	})
	expect(applied).toMatchObject({ would_grant: 0, granted: 3 })
	expect(
		sqlite
			.prepare(
				`SELECT resource_type, resource_id, subject_id, preset, origin FROM grants
				 WHERE deleted_at IS NULL ORDER BY resource_type, resource_id`,
			)
			.all(),
	).toEqual([
		{
			resource_type: 'app',
			resource_id: 'pkg-member',
			subject_id: 'person-member',
			preset: 'manage',
			origin: 'created',
		},
		{
			resource_type: 'app',
			resource_id: 'pkg-revoked',
			subject_id: 'person-member',
			preset: 'manage',
			origin: 'created',
		},
		{
			resource_type: 'package',
			resource_id: 'pkg-member',
			subject_id: 'person-member',
			preset: 'manage',
			origin: 'created',
		},
	])

	const rerun = await runCreatorAccessBackfill({
		env,
		dryRun: false,
		audit: createTestOrgAuditWriter({ db: auditDb, appDb: env.APP_DB }),
		afterOrgId: null,
	})
	expect(rerun).toMatchObject({
		granted: 0,
		would_grant: 0,
		already_granted: 3,
	})
})
