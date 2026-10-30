import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { buildPackageJobId } from '@kody-internal/shared/jobs/package-job-id.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { insertTestUser } from '#worker/test-support/account-export.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import {
	disableEnablement,
	insertEnablement,
	listEnablementsForInstance,
} from './repo.ts'
import {
	backfillOwnerCronEnablements,
	ensureOwnerCronEnablementForJob,
	resolveOwnerPersonIdForCronEnablement,
} from './owner-cron-enablement.ts'

const mockListJobsPage = vi.hoisted(() => vi.fn())

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsPage: (...args: Array<unknown>) => mockListJobsPage(...args),
	}),
}))

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	insertTestUser(sqlite, {
		id: 1,
		username: 'noah',
		stableUserId: 'user-noah',
	})
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: 'user-noah',
		username: 'noah',
	})
	return { sqlite, db, env: { APP_DB: db } as Env }
}

test('resolveOwnerPersonIdForCronEnablement returns the personal-org person', async () => {
	const { db } = await setup()
	expect(
		await resolveOwnerPersonIdForCronEnablement(
			db,
			ownerIdFromStored('user-noah'),
		),
	).toBe(personIdFromStored('user-noah'))
})

test('ensureOwnerCronEnablementForJob inserts once and is idempotent', async () => {
	const { db } = await setup()
	const packageId = 'e0c8c4c7-25fb-4d44-9446-3ee7cf4677dd'
	const jobName = 'inbox-refresh'
	const jobId = buildPackageJobId(packageId, jobName)
	const orgId = ownerIdFromStored('user-noah')

	expect(
		await ensureOwnerCronEnablementForJob({
			db,
			orgId,
			jobId,
			jobName,
			packageId,
			now: '2026-10-15T12:00:00.000Z',
		}),
	).toBe('inserted')

	const enablements = await listEnablementsForInstance({
		db,
		orgId: String(orgId),
		triggerKind: 'cron',
		instanceId: jobId,
		triggerName: jobName,
	})
	expect(enablements).toHaveLength(1)
	expect(enablements[0]).toMatchObject({
		state: 'on',
		origin: 'enabled',
		enablerUserId: personIdFromStored('user-noah'),
		packageId,
		triggerName: jobName,
	})

	expect(
		await ensureOwnerCronEnablementForJob({
			db,
			orgId,
			jobId,
			jobName,
			packageId,
		}),
	).toBe('already_present')
	expect(
		await listEnablementsForInstance({
			db,
			orgId: String(orgId),
			triggerKind: 'cron',
			instanceId: jobId,
			triggerName: jobName,
		}),
	).toHaveLength(1)
})

test('a job enabled through a scoped credential keeps that narrowing', async () => {
	const { db } = await setup()
	const packageId = 'e0c8c4c7-25fb-4d44-9446-3ee7cf4677dd'
	const jobName = 'inbox-refresh'
	const jobId = buildPackageJobId(packageId, jobName)
	const orgId = ownerIdFromStored('user-noah')
	expect(
		await ensureOwnerCronEnablementForJob({
			db,
			orgId,
			jobId,
			jobName,
			packageId,
			enablerUserId: personIdFromStored('user-noah'),
			enablerCredential: { scopes: ['package:execute'], profileName: 'work' },
		}),
	).toBe('inserted')
	const [enablement] = await listEnablementsForInstance({
		db,
		orgId: String(orgId),
		triggerKind: 'cron',
		instanceId: jobId,
		triggerName: jobName,
	})
	expect(enablement).toMatchObject({
		enablerScopes: ['package:execute'],
		enablerProfileName: 'work',
	})
})

test('turning a job on again records the credential that turned it on', async () => {
	const { db } = await setup()
	const packageId = 'e0c8c4c7-25fb-4d44-9446-3ee7cf4677dd'
	const jobName = 'inbox-refresh'
	const jobId = buildPackageJobId(packageId, jobName)
	const orgId = ownerIdFromStored('user-noah')
	const enable = (input: {
		scopes: Array<OrgPermission> | null
		refresh: boolean
	}) =>
		ensureOwnerCronEnablementForJob({
			db,
			orgId,
			jobId,
			jobName,
			packageId,
			enablerUserId: personIdFromStored('user-noah'),
			enablerCredential: { scopes: input.scopes, profileName: null },
			refreshEnablerCredential: input.refresh,
		})
	const stored = async () =>
		(
			await listEnablementsForInstance({
				db,
				orgId: String(orgId),
				triggerKind: 'cron',
				instanceId: jobId,
				triggerName: jobName,
			})
		).map((row) => row.enablerScopes)

	// Package create writes the row (job still off) with an unscoped session.
	expect(await enable({ scopes: null, refresh: false })).toBe('inserted')
	// Editing an already-on job keeps the narrowing it was turned on with.
	await enable({ scopes: ['job:write'], refresh: false })
	expect(await stored()).toEqual([null])
	// A scoped token turning the job on narrows the existing row.
	expect(await enable({ scopes: ['job:write'], refresh: true })).toBe(
		'already_present',
	)
	expect(await stored()).toEqual([['job:write']])
})

test('stored enabler scopes that cannot be read narrow to nothing', async () => {
	const { db, sqlite } = await setup()
	const packageId = 'e0c8c4c7-25fb-4d44-9446-3ee7cf4677dd'
	const jobId = buildPackageJobId(packageId, 'a')
	const orgId = ownerIdFromStored('user-noah')
	await ensureOwnerCronEnablementForJob({
		db,
		orgId,
		jobId,
		jobName: 'a',
		packageId,
	})
	const list = () =>
		listEnablementsForInstance({
			db,
			orgId: String(orgId),
			triggerKind: 'cron',
			instanceId: jobId,
			triggerName: 'a',
		})
	expect((await list())[0]).toMatchObject({
		enablerScopes: null,
		enablerProfileName: null,
	})
	sqlite.exec(`UPDATE enablements SET enabler_scopes_json = 'not json'`)
	expect((await list())[0]?.enablerScopes).toEqual([])
})

test('backfillOwnerCronEnablements dryRun and apply insert missing owner enablements', async () => {
	const { db, env } = await setup()
	const packageId = 'pkg-backfill'
	const jobName = 'sweep'
	const jobId = buildPackageJobId(packageId, jobName)
	const orgId = ownerIdFromStored('user-noah')

	mockListJobsPage.mockReset()
	mockListJobsPage.mockResolvedValueOnce([
		{
			id: jobId,
			user_id: String(orgId),
			name: jobName,
			deleted_at: null,
			record: {
				id: jobId,
				userId: orgId,
				name: jobName,
				enabled: true,
			},
		},
		{
			id: buildPackageJobId(packageId, 'disabled'),
			user_id: String(orgId),
			name: 'disabled',
			deleted_at: null,
			record: {
				id: buildPackageJobId(packageId, 'disabled'),
				userId: orgId,
				name: 'disabled',
				enabled: false,
			},
		},
	])

	const dry = await backfillOwnerCronEnablements({
		env,
		dryRun: true,
		limit: 100,
	})
	expect(dry.dryRun).toBe(true)
	expect(dry.counts).toMatchObject({
		scanned: 2,
		inserted: 1,
		skippedNotEnabled: 1,
		alreadyPresent: 0,
		failed: 0,
	})
	expect(
		await listEnablementsForInstance({
			db,
			orgId: String(orgId),
			triggerKind: 'cron',
			instanceId: jobId,
			triggerName: jobName,
		}),
	).toHaveLength(0)

	mockListJobsPage.mockResolvedValueOnce([
		{
			id: jobId,
			user_id: String(orgId),
			name: jobName,
			deleted_at: null,
			record: {
				id: jobId,
				userId: orgId,
				name: jobName,
				enabled: true,
			},
		},
	])
	const applied = await backfillOwnerCronEnablements({
		env,
		dryRun: false,
		limit: 100,
	})
	expect(applied.dryRun).toBe(false)
	expect(applied.counts.inserted).toBe(1)
	expect(
		await listEnablementsForInstance({
			db,
			orgId: String(orgId),
			triggerKind: 'cron',
			instanceId: jobId,
			triggerName: jobName,
		}),
	).toHaveLength(1)

	mockListJobsPage.mockResolvedValueOnce([
		{
			id: jobId,
			user_id: String(orgId),
			name: jobName,
			deleted_at: null,
			record: {
				id: jobId,
				userId: orgId,
				name: jobName,
				enabled: true,
			},
		},
	])
	const again = await backfillOwnerCronEnablements({
		env,
		dryRun: false,
		limit: 100,
	})
	expect(again.counts).toMatchObject({
		scanned: 1,
		inserted: 0,
		alreadyPresent: 1,
	})
})

test('sync create path helper skips when no live owner exists', async () => {
	const { db } = await setup()
	expect(
		await ensureOwnerCronEnablementForJob({
			db,
			orgId: ownerIdFromStored('missing-org'),
			jobId: buildPackageJobId('pkg-x', 'tick'),
			jobName: 'tick',
			packageId: 'pkg-x',
		}),
	).toBe('skipped_no_owner')
})

test('ensureOwnerCronEnablementForJob does not re-enable an owner who turned off', async () => {
	const { db } = await setup()
	const packageId = 'pkg-off'
	const jobName = 'sweep'
	const jobId = buildPackageJobId(packageId, jobName)
	const orgId = ownerIdFromStored('user-noah')
	const created = await insertEnablement({
		db,
		enablement: {
			orgId: String(orgId),
			packageId,
			triggerKind: 'cron',
			triggerName: jobName,
			instanceId: jobId,
			enablerUserId: 'user-noah',
			origin: 'enabled',
		},
	})
	await disableEnablement({
		db,
		orgId: String(orgId),
		id: created.id,
	})
	expect(
		await ensureOwnerCronEnablementForJob({
			db,
			orgId,
			jobId,
			jobName,
			packageId,
		}),
	).toBe('already_present')
	expect(
		await listEnablementsForInstance({
			db,
			orgId: String(orgId),
			triggerKind: 'cron',
			instanceId: jobId,
			triggerName: jobName,
		}),
	).toHaveLength(0)
})
