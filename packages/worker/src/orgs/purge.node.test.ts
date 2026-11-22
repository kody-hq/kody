import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const hardPurgeOrg = vi.fn(async (input: { env: Env; orgId: string }) => {
	await input.env.APP_DB.prepare(`DELETE FROM orgs WHERE id = ?`)
		.bind(input.orgId)
		.run()
	return { orgId: input.orgId, deletedTables: { orgs: 1 } }
})

const finishLegacyUserDeletion = vi.fn(
	async (input: {
		env: Env
		dbUserId: number
		stableUserId: string
		afterStep?: () => Promise<void>
	}) => {
		await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
			.bind(input.dbUserId)
			.run()
		return { alreadyGone: false }
	},
)

const hardPurgeSoftDeletedUser = vi.fn()

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(),
	setContext: vi.fn(),
}))

vi.mock(import('@sentry/cloudflare'), async (importOriginal) => ({
	...(await importOriginal()),
	isInitialized: () => true,
	captureException: sentry.captureException,
	withScope: (
		callback: (scope: {
			setLevel: () => void
			setTag: () => void
			setContext: typeof sentry.setContext
		}) => void,
	) =>
		callback({
			setLevel: () => {},
			setTag: () => {},
			setContext: sentry.setContext,
		}),
}))

vi.mock('./hard-purge.ts', () => ({
	hardPurgeOrg: (input: { env: Env; orgId: string }) => hardPurgeOrg(input),
	hardPurgeSoftDeletedUser: (input: unknown) => hardPurgeSoftDeletedUser(input),
	finishLegacyUserDeletion: (input: {
		env: Env
		dbUserId: number
		stableUserId: string
		afterStep?: () => Promise<void>
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

async function purgeClaimState(db: D1Database, id: number) {
	return await db
		.prepare(
			`SELECT purge_attempts, purge_fence_until, purge_blocked_at FROM users WHERE id = ?`,
		)
		.bind(id)
		.first<{
			purge_attempts: number
			purge_fence_until: string | null
			purge_blocked_at: string | null
		}>()
}

function minutesAfter(start: Date, minutes: number) {
	return new Date(start.getTime() + minutes * 60 * 1000)
}

type LegacyFinishInput = {
	env: Env
	dbUserId: number
	stableUserId: string
	afterStep?: () => Promise<void>
}

afterEach(() => {
	vi.useRealTimers()
})

beforeEach(() => {
	sentry.captureException.mockClear()
	sentry.setContext.mockClear()
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
	const failed = await pruneSoftDeleted({ env, now })
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
	const soon = new Date(now.getTime() + 60 * 60 * 1000)
	const skipped = await pruneSoftDeleted({ env, now: soon })
	expect(skipped.scanned).toBe(0)

	// After the fence the next pass retries and finishes.
	const later = new Date(now.getTime() + 25 * 60 * 60 * 1000)
	const retried = await pruneSoftDeleted({ env, now: later })
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

test('an expired claim lease lets another pass take the item', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(now)
	const { env, db } = await createEnv(false)
	await seedUser(db, {
		id: 51,
		stableUserId: 'legacy-stalled',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	const passes: Array<{ scanned: number; purged: number }> = []
	finishLegacyUserDeletion.mockImplementationOnce(
		async (input: LegacyFinishInput) => {
			// The first pass stalls without completing a step.
			const live = await pruneSoftDeleted({
				env,
				now: minutesAfter(now, 10),
			})
			passes.push({ scanned: live.scanned, purged: live.purged })
			const expired = await pruneSoftDeleted({
				env,
				now: minutesAfter(now, 16),
			})
			passes.push({ scanned: expired.scanned, purged: expired.purged })
			return { alreadyGone: input.dbUserId === 0 }
		},
	)

	const first = await pruneSoftDeleted({ env, now })
	expect(first.purged).toBe(1)
	expect(passes).toEqual([
		{ scanned: 0, purged: 0 },
		{ scanned: 1, purged: 1 },
	])
	expect(finishLegacyUserDeletion).toHaveBeenCalledTimes(2)
	expect(await userRow(db, 51)).toBeNull()
})

test('renewing the lease after a completed step prevents takeover', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(now)
	const { env, db } = await createEnv(false)
	await seedUser(db, {
		id: 52,
		stableUserId: 'legacy-renewed',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	let takeover: { scanned: number; purged: number } | undefined
	finishLegacyUserDeletion.mockImplementationOnce(
		async (input: LegacyFinishInput) => {
			vi.setSystemTime(minutesAfter(now, 10))
			await input.afterStep?.()
			expect((await purgeClaimState(db, 52))?.purge_fence_until).toBe(
				minutesAfter(now, 25).toISOString(),
			)
			const other = await pruneSoftDeleted({
				env,
				now: minutesAfter(now, 16),
			})
			takeover = { scanned: other.scanned, purged: other.purged }
			await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.run()
			await input.afterStep?.()
			return { alreadyGone: false }
		},
	)

	const result = await pruneSoftDeleted({ env, now })
	expect(result.purged).toBe(1)
	expect(takeover).toEqual({ scanned: 0, purged: 0 })
	expect(finishLegacyUserDeletion).toHaveBeenCalledTimes(1)
})

test('a failure keeps the claim behind a 24 hour fence and counts the attempt', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(now)
	const { env, db } = await createEnv(false)
	await seedUser(db, {
		id: 53,
		stableUserId: 'legacy-fenced',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	finishLegacyUserDeletion.mockImplementationOnce(async () => {
		throw new Error('cleanup failed')
	})
	consoleWarn.mockImplementation(() => {})

	expect((await pruneSoftDeleted({ env, now })).failed).toBe(1)
	expect(await purgeClaimState(db, 53)).toEqual({
		purge_attempts: 1,
		purge_fence_until: minutesAfter(now, 24 * 60).toISOString(),
		purge_blocked_at: null,
	})
	expect(
		(await pruneSoftDeleted({ env, now: minutesAfter(now, 24 * 60 - 1) }))
			.scanned,
	).toBe(0)
	expect(sentry.captureException).not.toHaveBeenCalled()
})

test('the fifth failure blocks the item, audits purge.blocked once, and blocked items are skipped', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	const { env, db } = await createEnv(false)
	await seedUser(db, {
		id: 54,
		stableUserId: 'legacy-blocked',
		deletingAt: '2026-08-20T00:00:00.000Z',
		deletedAt: null,
	})
	finishLegacyUserDeletion.mockImplementation(async () => {
		throw new Error('cleanup failed')
	})
	consoleWarn.mockImplementation(() => {})

	for (let attempt = 1; attempt <= 5; attempt++) {
		const passAt = minutesAfter(now, (attempt - 1) * 25 * 60)
		vi.setSystemTime(passAt)
		expect((await pruneSoftDeleted({ env, now: passAt })).failed).toBe(1)
		const state = await purgeClaimState(db, 54)
		expect(state?.purge_attempts).toBe(attempt)
		expect(state?.purge_blocked_at).toBe(
			attempt === 5 ? passAt.toISOString() : null,
		)
	}

	const blockedAudits = async () =>
		(
			await env.AUDIT_DB.prepare(
				`SELECT resource_type, resource_id, details_json FROM org_audit_events
				 WHERE org_id = ? AND action = 'purge.blocked'`,
			)
				.bind('legacy-blocked')
				.all<{
					resource_type: string
					resource_id: string
					details_json: string
				}>()
		).results
	const audits = await blockedAudits()
	expect(audits).toHaveLength(1)
	expect(audits[0]).toMatchObject({
		resource_type: 'user',
		resource_id: 'legacy-blocked',
	})
	expect(JSON.parse(audits[0]!.details_json)).toEqual({
		kind: 'user',
		id: 'legacy-blocked',
		attempts: 5,
		lastFailure: 'cleanup failed',
		lane: 'legacy_deletion_finish',
	})
	expect(sentry.captureException).toHaveBeenCalledTimes(1)
	expect(sentry.setContext).toHaveBeenCalledWith('purge_blocked', {
		kind: 'user',
		id: 'legacy-blocked',
		attempts: 5,
		lastFailure: 'cleanup failed',
	})

	finishLegacyUserDeletion.mockClear()
	const muchLater = minutesAfter(now, 30 * 24 * 60)
	vi.setSystemTime(muchLater)
	const skipped = await pruneSoftDeleted({ env, now: muchLater })
	expect(skipped.scanned).toBe(0)
	expect(finishLegacyUserDeletion).not.toHaveBeenCalled()
	expect(await blockedAudits()).toHaveLength(1)
	expect(sentry.captureException).toHaveBeenCalledTimes(1)
	expect(
		(await listSoftDeletePurgeCandidates({ env, now: muchLater })).scanned,
	).toBe(0)
})

test('blocked soft-deleted orgs are skipped by the org lane', async () => {
	const { env, db } = await createEnv(true)
	await seedSoftDeletedOrg(db, 'org-blocked')
	await db
		.prepare(
			`UPDATE orgs SET purge_attempts = 5, purge_blocked_at = ? WHERE id = ?`,
		)
		.bind(now.toISOString(), 'org-blocked')
		.run()
	const result = await pruneSoftDeleted({ env, now })
	expect(result.scanned).toBe(0)
	expect(hardPurgeOrg).not.toHaveBeenCalled()
})
