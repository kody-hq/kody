/**
 * Turning a cron enablement on must also turn its job row on. The scheduler
 * picks a job only when the row is enabled, then runs once per on enablement,
 * so an on enablement on a disabled job never runs. Real migrated APP_DB with
 * the jobs-worker schema, a real team org, membership, and grants.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { getJobRowById, insertJobRow } from '@kody-internal/shared/jobs/repo.ts'
import { expect, test, vi } from 'vitest'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import { type JobRecord } from '#worker/jobs/types.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyMigrations } from '#worker/test-support/account-export.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { disableEnablement, listEnablementsForInstance } from './repo.ts'
import { enableTriggerForCaller } from './service.ts'

const mocks = vi.hoisted(() => ({
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const now = '2026-10-11T00:00:00.000Z'
const jobName = 'daily'
const staleNextRunAt = '2026-10-01T11:15:00.000Z'

async function insertAccount(
	db: D1Database,
	input: { email: string; username: string },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, 'test-password-hash', ?, ?)`,
		)
		.bind(input.username, input.email, now, stableUserId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username: input.username,
		createdAt: now,
	})
	return personIdFromStored(stableUserId)
}

async function setup(job: Partial<JobRecord> = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	const db = createD1FromSqlite(sqlite)
	const ownerId = await insertAccount(db, {
		email: 'owner@acme.example',
		username: 'owner',
	})
	const beaId = await insertAccount(db, {
		email: 'bea@acme.example',
		username: 'bea',
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: ownerId,
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const teamOrg = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks'`)
		.first<{ id: string }>()
	const orgId = ownerIdFromStored(teamOrg!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(orgId, beaId, now)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-shared', ?, '@acme/pkg-shared', 'pkg-shared', '', 'source-pkg-shared')`,
		)
		.bind(orgId)
		.run()
	// Bea may run pkg-shared (Use) but holds no job:write.
	await upsertGrant({
		db,
		orgId,
		subject: { type: 'user', id: beaId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
		resourceType: 'package',
		resourceId: 'pkg-shared',
	})
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async ({ sourceId }: { sourceId: string }) => ({
			manifest: {
				name: sourceId,
				kody: {
					id: sourceId,
					description: sourceId,
					jobs: {
						[jobName]: {
							entry: './src/job.ts',
							schedule: { type: 'interval', every: '1h' },
						},
					},
				},
			},
		}),
	)
	const jobId = buildPackageJobId('pkg-shared', jobName)
	const record: JobRecord = {
		version: 1,
		id: jobId,
		userId: orgId,
		name: jobName,
		sourceId: 'source-pkg-shared',
		publishedCommit: 'commit-1',
		storageId: `job-storage-${jobId}`,
		schedule: { type: 'interval', every: '1h' },
		timezone: 'UTC',
		enabled: false,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: now,
		updatedAt: now,
		nextRunAt: staleNextRunAt,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...job,
	}
	await insertJobRow({
		db,
		userId: orgId,
		job: record,
		callerContextJson: '{}',
	})
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		APP_BASE_URL: 'https://kody.example',
		...createInMemoryUserMeterEnv().env,
	} as unknown as Env
	const people = {
		owner: { userId: ownerId, username: 'owner' },
		bea: { userId: beaId, username: 'bea' },
	} as const
	const enable = async (person: keyof typeof people) => {
		const row = await db
			.prepare(
				`SELECT role FROM org_memberships
				 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(orgId, people[person].userId)
			.first<{ role: OrgRole }>()
		return enableTriggerForCaller({
			env,
			baseUrl: 'https://kody.example',
			request: deriveRequestContext({
				user: people[person],
				source: { kind: 'session' },
				orgBinding: {
					org: { id: orgId, slug: 'quillworks' },
					role: row?.role ?? null,
				},
			}),
			packageIdOrKodyId: 'pkg-shared',
			kind: 'cron',
			name: jobName,
		})
	}
	const readJob = async () => (await getJobRowById(db, orgId, jobId))!.record
	return { db, orgId, jobId, enable, readJob }
}

test('enablementEnable turns a disabled cron job on and schedules it from now', async () => {
	const t = await setup()
	const before = Date.now()
	expect(await t.enable('owner')).toMatchObject({
		triggerKind: 'cron',
		state: 'on',
	})
	const job = await t.readJob()
	expect(job.enabled).toBe(true)
	expect(job.nextRunAt).not.toBe(staleNextRunAt)
	expect(new Date(job.nextRunAt!).valueOf()).toBeGreaterThan(before)
})

test('re-enabling an enablement that is already on still turns its disabled job on', async () => {
	const t = await setup()
	const first = await t.enable('owner')
	// The job is turned off later (jobUpdate enabled:false keeps the enablement on).
	await t.db
		.prepare(`UPDATE jobs SET enabled = 0, next_run_at = ? WHERE id = ?`)
		.bind(staleNextRunAt, t.jobId)
		.run()
	const again = await t.enable('owner')
	expect(again.id).toBe(first.id)
	const job = await t.readJob()
	expect(job.enabled).toBe(true)
	expect(job.nextRunAt).not.toBe(staleNextRunAt)
})

test('turning an enablement back on after it was turned off turns the job on', async () => {
	const t = await setup()
	const first = await t.enable('owner')
	await disableEnablement({ db: t.db, orgId: t.orgId, id: first.id })
	await t.db
		.prepare(`UPDATE jobs SET enabled = 0, next_run_at = ? WHERE id = ?`)
		.bind(staleNextRunAt, t.jobId)
		.run()
	expect(await t.enable('owner')).toMatchObject({ state: 'on' })
	expect((await t.readJob()).enabled).toBe(true)
})

test('a member without job:write gets their enablement but the job stays as its writers left it', async () => {
	const t = await setup()
	expect(await t.enable('bea')).toMatchObject({ state: 'on' })
	const job = await t.readJob()
	expect(job.enabled).toBe(false)
	expect(job.nextRunAt).toBe(staleNextRunAt)
	const live = await listEnablementsForInstance({
		db: t.db,
		orgId: t.orgId,
		triggerKind: 'cron',
		instanceId: t.jobId,
	})
	expect(live).toHaveLength(1)
})

test('an expired job stays off', async () => {
	const t = await setup({ expiresAt: '2026-10-02T00:00:00.000Z' })
	await t.enable('owner')
	expect((await t.readJob()).enabled).toBe(false)
})
