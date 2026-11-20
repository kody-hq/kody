import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createManualClock } from '#worker/test-support/manual-clock.ts'
import {
	PurgeBlockedError,
	purgeClaimLeaseMs,
	purgeFailureFenceMs,
} from '#worker/scheduled/retention/purge-lease.ts'

const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }))

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isInitialized: () => true,
	getClient: () => ({
		getOptions: () => ({ dsn: 'https://purge@example.com/1' }),
	}),
	captureException: sentryMock.captureException,
}))

type HardPurgeOrgInput = {
	env: Env
	orgId: string
	onStepComplete?: () => Promise<void>
}

const hardPurgeOrg = vi.fn(async (input: HardPurgeOrgInput) => {
	await input.env.APP_DB.prepare(`DELETE FROM orgs WHERE id = ?`)
		.bind(input.orgId)
		.run()
	return { orgId: input.orgId, deletedTables: { orgs: 1 } }
})

const finishLegacyUserDeletion = vi.fn(
	async (input: { env: Env; dbUserId: number; stableUserId: string }) => {
		await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
			.bind(input.dbUserId)
			.run()
		return { alreadyGone: false }
	},
)

const hardPurgeSoftDeletedUser = vi.fn()

vi.mock('./hard-purge.ts', () => ({
	hardPurgeOrg: (input: HardPurgeOrgInput) => hardPurgeOrg(input),
	hardPurgeSoftDeletedUser: (input: unknown) => hardPurgeSoftDeletedUser(input),
	finishLegacyUserDeletion: (input: {
		env: Env
		dbUserId: number
		stableUserId: string
	}) => finishLegacyUserDeletion(input),
}))

const {
	listSoftDeletePurgeCandidates,
	pruneSoftDeleted,
	softDeletePurgeWritesEnabled,
} = await import('./purge.ts')

const now = new Date('2026-10-01T12:00:00.000Z')
const oldDeletedAt = '2025-08-01T00:00:00.000Z'

function createAuditDb() {
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../audit-migrations/0002-org-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return createD1FromSqlite(auditSqlite)
}

async function createEnv(purgeEnabled: boolean) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditDb()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		SOFT_DELETE_PURGE_ENABLED: purgeEnabled ? 'true' : 'false',
	} as Env
	return { env, db }
}

async function seedSoftDeletedOrg(db: D1Database, orgId: string) {
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, deleted_at, created_at, updated_at)
			VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
		)
		.bind(orgId, orgId, orgId, oldDeletedAt, ts, oldDeletedAt)
		.run()
}

async function seedUser(
	db: D1Database,
	input: {
		id: number
		stableUserId: string
		deletingAt: string | null
		deletedAt: string | null
	},
) {
	const ts = '2026-01-01T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, stable_user_id,
				created_at, updated_at, deleting_at, deleted_at
			) VALUES (?, ?, ?, 'hash', ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.stableUserId,
			`${input.stableUserId}@example.com`,
			input.stableUserId,
			ts,
			ts,
			input.deletingAt,
			input.deletedAt,
		)
		.run()
}

async function userRow(db: D1Database, id: number) {
	return await db
		.prepare(`SELECT deleting_at, deleted_at FROM users WHERE id = ?`)
		.bind(id)
		.first<{ deleting_at: string | null; deleted_at: string | null }>()
}

async function orgPurgeState(db: D1Database, id: string) {
	return await db
		.prepare(
			`SELECT deleting_at, purge_lease_expires_at, purge_failed_attempts
			FROM orgs WHERE id = ?`,
		)
		.bind(id)
		.first()
}

function failOrgPurgeOnce() {
	hardPurgeOrg.mockImplementationOnce(async () => {
		throw new Error('org purge failed: upstream 500')
	})
}

beforeEach(() => {
	sentryMock.captureException.mockClear()
	hardPurgeOrg.mockClear()
	hardPurgeSoftDeletedUser.mockClear()
	finishLegacyUserDeletion.mockClear()
	finishLegacyUserDeletion.mockImplementation(async (input) => {
		await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
			.bind(input.dbUserId)
			.run()
		return { alreadyGone: false }
	})
})

test('purge dry-run lists old soft-deleted org', async () => {
	const { env, db } = await createEnv(false)
	await seedSoftDeletedOrg(db, 'org-purge-candidate')
	expect(softDeletePurgeWritesEnabled(env)).toBe(false)
	const preview = await listSoftDeletePurgeCandidates({ env, now })
	expect(
		preview.candidates.some(
			(c) => c.kind === 'org' && c.id === 'org-purge-candidate',
		),
	).toBe(true)
	const dryRun = await pruneSoftDeleted({ env, now, dryRun: true })
	expect(dryRun.purged).toBe(0)
	expect(dryRun.outcomes[0]?.outcome).toBe('would_purge')
	expect(hardPurgeOrg).not.toHaveBeenCalled()
	const stillThere = await db
		.prepare(`SELECT id FROM orgs WHERE id = ?`)
		.bind('org-purge-candidate')
		.first()
	expect(stillThere).toBeTruthy()
})

test('real purge with enabled flag hard-deletes idempotently', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-purge-real')
	const first = await pruneSoftDeleted({ env, now, dryRun: false })
	expect(first.failed, JSON.stringify(first.outcomes)).toBe(0)
	expect(first.purged).toBe(1)
	expect(hardPurgeOrg).toHaveBeenCalled()
	const gone = await db
		.prepare(`SELECT id FROM orgs WHERE id = ?`)
		.bind('org-purge-real')
		.first()
	expect(gone).toBeNull()
	const second = await pruneSoftDeleted({ env, now, dryRun: false })
	expect(second.purged).toBe(0)
})

test('personal orgs of soft-deleted people purge with the person, not as org candidates', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'person-fallback')
	await seedUser(db, {
		id: 1,
		stableUserId: 'person-fallback',
		deletingAt: null,
		deletedAt: oldDeletedAt,
	})
	await seedSoftDeletedOrg(db, 'personal-org-explicit')
	await seedUser(db, {
		id: 2,
		stableUserId: 'person-explicit',
		deletingAt: null,
		deletedAt: oldDeletedAt,
	})
	await db
		.prepare(`UPDATE users SET personal_org_id = ? WHERE id = ?`)
		.bind('personal-org-explicit', 2)
		.run()
	await seedSoftDeletedOrg(db, 'team-org')

	const preview = await listSoftDeletePurgeCandidates({ env, now })
	expect(
		preview.candidates.map((candidate) => [candidate.kind, candidate.id]),
	).toEqual([
		['org', 'team-org'],
		['user', 'person-explicit'],
		['user', 'person-fallback'],
	])

	// A person outside this pass's user batch still keeps its personal org
	// for the pass that purges the person, so no earlier pass deletes it.
	const smallBatch = await listSoftDeletePurgeCandidates({
		env,
		now,
		batchSize: 1,
	})
	expect(
		smallBatch.candidates.filter((candidate) => candidate.kind === 'org'),
	).toEqual([expect.objectContaining({ id: 'team-org' })])
})

test('legacy stuck deletions are listed without the restore window', async () => {
	const { env, db } = await createEnv(false)
	// Fenced by the pre-soft-delete flow nine days ago, never finished.
	await seedUser(db, {
		id: 11,
		stableUserId: 'legacy-stuck',
		deletingAt: '2026-09-22T12:00:00.000Z',
		deletedAt: null,
	})
	// Live account: never a candidate.
	await seedUser(db, {
		id: 12,
		stableUserId: 'live-person',
		deletingAt: null,
		deletedAt: null,
	})
	// Deletion started an hour ago and may still be running.
	await seedUser(db, {
		id: 13,
		stableUserId: 'in-flight',
		deletingAt: '2026-10-01T11:00:00.000Z',
		deletedAt: null,
	})
	// Soft-deleted inside the 30-day window: restorable, not a candidate.
	await seedUser(db, {
		id: 14,
		stableUserId: 'restorable',
		deletingAt: null,
		deletedAt: '2026-09-22T12:00:00.000Z',
	})
	const preview = await listSoftDeletePurgeCandidates({ env, now })
	expect(
		preview.candidates.map((candidate) => ({
			id: candidate.id,
			legacy: candidate.legacy ?? false,
		})),
	).toEqual([{ id: 'legacy-stuck', legacy: true }])
	expect(preview.candidates[0]?.ageDays).toBe(9)
})

test('scheduled pass finishes legacy deletions while soft-delete writes stay off', async () => {
	const { env, db } = await createEnv(false)
	await seedSoftDeletedOrg(db, 'org-still-dry-run')
	await seedUser(db, {
		id: 21,
		stableUserId: 'legacy-a',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	await seedUser(db, {
		id: 22,
		stableUserId: 'legacy-b',
		deletingAt: '2026-08-20 00:00:00',
		deletedAt: null,
	})
	// The scheduled lane passes no dryRun flag.
	const result = await pruneSoftDeleted({ env, now })
	expect(result.dryRun).toBe(true)
	expect(result.legacyDryRun).toBe(false)
	expect(result.failed).toBe(0)
	expect(result.purged).toBe(2)
	expect(hardPurgeOrg).not.toHaveBeenCalled()
	expect(finishLegacyUserDeletion).toHaveBeenCalledTimes(2)
	expect(
		result.outcomes.map((outcome) => [outcome.id, outcome.outcome]),
	).toEqual([
		['org-still-dry-run', 'would_purge'],
		['legacy-a', 'purged'],
		['legacy-b', 'purged'],
	])
	expect(await userRow(db, 21)).toBeNull()
	expect(await userRow(db, 22)).toBeNull()
	// Idempotent: nothing left to do on the next pass.
	finishLegacyUserDeletion.mockClear()
	const again = await pruneSoftDeleted({ env, now })
	expect(again.purged).toBe(0)
	expect(finishLegacyUserDeletion).not.toHaveBeenCalled()
})

test('explicit dryRun previews legacy deletions without claiming', async () => {
	const { env, db } = await createEnv(true)
	const deletingAt = '2026-08-20T00:00:00.000Z'
	await seedUser(db, {
		id: 31,
		stableUserId: 'legacy-preview',
		deletingAt,
		deletedAt: null,
	})
	const result = await pruneSoftDeleted({ env, now, dryRun: true })
	expect(result.legacyDryRun).toBe(true)
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			id: 'legacy-preview',
			outcome: 'would_purge',
			legacy: true,
		}),
	])
	expect(finishLegacyUserDeletion).not.toHaveBeenCalled()
	expect((await userRow(db, 31))?.deleting_at).toBe(deletingAt)
})

test('failed legacy deletion is audited, backs off, and retries later', async () => {
	const { env, db } = await createEnv(false)
	const clock = createManualClock(now)
	await seedUser(db, {
		id: 41,
		stableUserId: 'legacy-retry',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	finishLegacyUserDeletion.mockImplementationOnce(async () => {
		throw new Error('Artifact repo cleanup failed: upstream 500')
	})
	consoleWarn.mockImplementation(() => {})
	const failed = await pruneSoftDeleted({ env, clock })
	expect(failed.failed).toBe(1)
	expect(failed.outcomes[0]).toEqual(
		expect.objectContaining({
			id: 'legacy-retry',
			outcome: 'failed',
			legacy: true,
		}),
	)
	// The row stays fenced, the claim restamped the fence, and deleted_at
	// stays null so it never becomes restorable.
	const afterFailure = await userRow(db, 41)
	expect(afterFailure?.deleted_at).toBeNull()
	expect(afterFailure?.deleting_at).toBe(now.toISOString())
	const audit = await env.AUDIT_DB.prepare(
		`SELECT action, details_json FROM org_audit_events WHERE org_id = ?`,
	)
		.bind('legacy-retry')
		.first<{ action: string; details_json: string }>()
	expect(audit?.action).toBe('user.purge_failed')
	expect(audit?.details_json).toContain('legacy_deletion_finish')

	// Inside the 24 hour failure fence: not picked up again.
	await clock.advance(purgeFailureFenceMs - 60_000)
	const skipped = await pruneSoftDeleted({ env, clock })
	expect(skipped.scanned).toBe(0)

	// After the fence the next pass retries and finishes.
	await clock.advance(2 * 60_000)
	const retried = await pruneSoftDeleted({ env, clock })
	expect(retried.purged).toBe(1)
	expect(await userRow(db, 41)).toBeNull()
})

test('failed legacy deletion records the specific cleanup errors without ids', async () => {
	const { env, db } = await createEnv(false)
	await seedUser(db, {
		id: 42,
		stableUserId: 'legacy-cleanup-detail',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	const { AccountDeletionCleanupError } =
		await import('#app/account-deletion.ts')
	finishLegacyUserDeletion.mockImplementationOnce(async () => {
		throw new AccountDeletionCleanupError(
			[
				'Artifact repo delete failed for u-7f3a9c21e5-pkg-src: Repository not found',
				'KV delete failed for bundle-artifact:v1:src-8812abc: timeout',
				'Stripe cleanup failed for person@example.com',
				'Subscription cancel failed for sub_AbCdEfGhIj',
			],
			{} as never,
		)
	})
	consoleWarn.mockImplementation(() => {})
	const result = await pruneSoftDeleted({ env, now })
	expect(result.failed).toBe(1)
	const audit = await env.AUDIT_DB.prepare(
		`SELECT details_json FROM org_audit_events
			 WHERE org_id = ? AND action = 'user.purge_failed'`,
	)
		.bind('legacy-cleanup-detail')
		.first<{ details_json: string }>()
	const expectedCleanupErrors = [
		'Artifact repo delete failed for <id> Repository not found',
		'KV delete failed for <id> timeout',
		'Stripe cleanup failed for <email>',
		'Subscription cancel failed for <id>',
	]
	expect(JSON.parse(audit?.details_json ?? '{}')).toEqual({
		error: 'Account deletion cleanup could not complete safely.',
		lane: 'legacy_deletion_finish',
		cleanupErrors: expectedCleanupErrors,
	})
	const logged = consoleWarn.mock.calls
		.map(([line]) => (typeof line === 'string' ? line : ''))
		.filter((line) => line.includes('soft_delete_purge_candidate_failed'))
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	expect(logged).toEqual([
		{
			message: 'soft_delete_purge_candidate_failed',
			kind: 'user',
			lane: 'legacy_deletion_finish',
			error: 'Account deletion cleanup could not complete safely.',
			cleanupErrors: expectedCleanupErrors,
		},
	])
	expect(JSON.stringify(logged)).not.toContain('legacy-cleanup-detail')
})

test('a failed failure-audit write does not abort the rest of the purge batch', async () => {
	const { env, db } = await createEnv(false)
	// No org_audit_events table: every org audit write throws.
	env.AUDIT_DB = createD1FromSqlite(new DatabaseSync(':memory:'))
	await seedUser(db, {
		id: 51,
		stableUserId: 'legacy-audit-down-a',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	await seedUser(db, {
		id: 52,
		stableUserId: 'legacy-audit-down-b',
		deletingAt: '2026-08-21T00:00:00.000Z',
		deletedAt: null,
	})
	finishLegacyUserDeletion.mockImplementationOnce(async () => {
		throw new Error('Artifact repo cleanup failed: upstream 500')
	})
	consoleWarn.mockImplementation(() => {})
	const result = await pruneSoftDeleted({ env, now })
	expect(result).toMatchObject({ scanned: 2, purged: 1, failed: 1 })
	expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual([
		'failed',
		'purged',
	])
	expect(await userRow(db, 52)).toBeNull()
	expect(JSON.stringify(consoleWarn.mock.calls)).toContain(
		'soft_delete_purge_failure_audit_failed',
	)
})

test('an expired claim lease lets another pass claim the item', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-lease-expired')
	const clock = createManualClock(now)
	consoleWarn.mockImplementation(() => {})
	let takeover: Awaited<ReturnType<typeof pruneSoftDeleted>> | undefined
	hardPurgeOrg.mockImplementationOnce(async (input) => {
		await clock.advance(purgeClaimLeaseMs + 1)
		takeover = await pruneSoftDeleted({ env, clock })
		await input.onStepComplete?.()
		return { orgId: input.orgId, deletedTables: { orgs: 0 } }
	})

	const stalled = await pruneSoftDeleted({ env, clock })
	expect(takeover?.outcomes).toEqual([
		expect.objectContaining({ id: 'org-lease-expired', outcome: 'purged' }),
	])
	// The stalled pass cannot renew a lease it lost, so it stops.
	expect(stalled.outcomes).toEqual([
		expect.objectContaining({
			id: 'org-lease-expired',
			outcome: 'failed',
			error: 'purge_lease_lost:orgs',
		}),
	])
	expect(hardPurgeOrg).toHaveBeenCalledTimes(2)
	expect(await orgPurgeState(db, 'org-lease-expired')).toBeNull()
})

test('renewing the lease after a completed step prevents takeover', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-lease-renewed')
	const clock = createManualClock(now)
	let contender: Awaited<ReturnType<typeof pruneSoftDeleted>> | undefined
	hardPurgeOrg.mockImplementationOnce(async (input) => {
		await clock.advance(purgeClaimLeaseMs - 60_000)
		await input.onStepComplete?.()
		await clock.advance(purgeClaimLeaseMs - 60_000)
		contender = await pruneSoftDeleted({ env, clock })
		await input.env.APP_DB.prepare(`DELETE FROM orgs WHERE id = ?`)
			.bind(input.orgId)
			.run()
		return { orgId: input.orgId, deletedTables: { orgs: 1 } }
	})

	const owner = await pruneSoftDeleted({ env, clock })
	expect(contender?.scanned).toBe(0)
	expect(owner.outcomes).toEqual([
		expect.objectContaining({ id: 'org-lease-renewed', outcome: 'purged' }),
	])
	expect(hardPurgeOrg).toHaveBeenCalledTimes(1)
})

test('a failed purge keeps the claim behind a 24 hour fence and counts the attempt', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-fenced')
	const clock = createManualClock(now)
	consoleWarn.mockImplementation(() => {})
	failOrgPurgeOnce()

	expect((await pruneSoftDeleted({ env, clock })).failed).toBe(1)
	expect(await orgPurgeState(db, 'org-fenced')).toEqual({
		deleting_at: now.toISOString(),
		purge_lease_expires_at: new Date(
			now.getTime() + purgeFailureFenceMs,
		).toISOString(),
		purge_failed_attempts: 1,
	})

	await clock.advance(purgeFailureFenceMs - 60_000)
	expect((await pruneSoftDeleted({ env, clock })).scanned).toBe(0)

	await clock.advance(2 * 60_000)
	failOrgPurgeOnce()
	expect((await pruneSoftDeleted({ env, clock })).failed).toBe(1)
	expect(await orgPurgeState(db, 'org-fenced')).toMatchObject({
		purge_failed_attempts: 2,
	})
	expect(hardPurgeOrg).toHaveBeenCalledTimes(2)
})

test('the 5th failed attempt blocks the item, audits and reports it once, and later passes skip it', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-blocked')
	const clock = createManualClock(now)
	consoleWarn.mockImplementation(() => {})
	const outcomes = []
	for (let attempt = 1; attempt <= 5; attempt++) {
		failOrgPurgeOnce()
		const result = await pruneSoftDeleted({ env, clock })
		outcomes.push(result.outcomes[0])
		await clock.advance(purgeFailureFenceMs + 1)
	}
	expect(outcomes.map((outcome) => outcome?.blocked)).toEqual([
		undefined,
		undefined,
		undefined,
		undefined,
		true,
	])

	await clock.advance(30 * 24 * 60 * 60 * 1000)
	expect((await pruneSoftDeleted({ env, clock })).scanned).toBe(0)
	expect(
		(await listSoftDeletePurgeCandidates({ env, clock })).candidates,
	).toEqual([])
	expect(hardPurgeOrg).toHaveBeenCalledTimes(5)
	expect(await orgPurgeState(db, 'org-blocked')).toMatchObject({
		purge_failed_attempts: 5,
	})

	const blockedAudits = await env.AUDIT_DB.prepare(
		`SELECT org_id, result, details_json FROM org_audit_events
		WHERE action = 'purge.blocked'`,
	).all<{ org_id: string; result: string; details_json: string }>()
	expect(
		blockedAudits.results.map((row) => ({
			...row,
			details_json: JSON.parse(row.details_json),
		})),
	).toEqual([
		{
			org_id: 'org-blocked',
			result: 'failure',
			details_json: {
				kind: 'org',
				id: 'org-blocked',
				attempts: 5,
				lastFailure: outcomes[4]?.error,
			},
		},
	])
	expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
	expect(sentryMock.captureException).toHaveBeenCalledWith(
		expect.any(PurgeBlockedError),
	)
})
