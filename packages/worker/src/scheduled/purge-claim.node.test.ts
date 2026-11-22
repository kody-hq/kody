import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	captureMessage: vi.fn(),
	hardPurgeOrg: vi.fn(),
}))

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
	...(await importOriginal<typeof import('@sentry/cloudflare')>()),
	isInitialized: () => true,
	withScope: (run: (scope: unknown) => void) =>
		run({
			setLevel: vi.fn(),
			setTag: vi.fn(),
			setFingerprint: vi.fn(),
			setContext: vi.fn(),
		}),
	captureMessage: mocks.captureMessage,
}))

vi.mock('#worker/orgs/hard-purge.ts', () => ({
	hardPurgeOrg: (input: unknown) => mocks.hardPurgeOrg(input),
	hardPurgeSoftDeletedUser: vi.fn(),
	finishLegacyUserDeletion: vi.fn(),
}))

const { pruneSoftDeleted } = await import('#worker/orgs/purge.ts')
const { purgeClaimFailureFenceMs, purgeClaimLeaseMs, purgeClaimMaxAttempts } =
	await import('./purge-claim.ts')

type HardPurgeOrgInput = {
	env: Env
	orgId: string
	onStepComplete?: () => Promise<void>
}

const now = new Date('2026-10-01T12:00:00.000Z')
const minuteMs = 60_000
const hourMs = 60 * minuteMs
const orgId = 'org-claim'

function later(ms: number) {
	return new Date(now.getTime() + ms)
}

async function deleteOrg(input: HardPurgeOrgInput) {
	await input.env.APP_DB.prepare(`DELETE FROM orgs WHERE id = ?`)
		.bind(input.orgId)
		.run()
}

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
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
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, deleted_at, created_at, updated_at)
			VALUES (?, ?, ?, 'free', 'public', ?, ?, ?)`,
		)
		.run(
			orgId,
			orgId,
			orgId,
			'2025-08-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z',
			'2025-08-01T00:00:00.000Z',
		)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		SOFT_DELETE_PURGE_ENABLED: 'true',
	} as Env
	return {
		env,
		claimRow() {
			return sqlite
				.prepare(
					`SELECT purge_claim_holder, purge_claim_until, purge_attempts, purge_blocked_at
					FROM orgs WHERE id = ?`,
				)
				.get(orgId) as
				| {
						purge_claim_holder: string | null
						purge_claim_until: string | null
						purge_attempts: number
						purge_blocked_at: string | null
				  }
				| undefined
		},
		blockedAudits() {
			return (
				auditSqlite
					.prepare(
						`SELECT org_id, resource_type, resource_id, result, details_json
						FROM org_audit_events WHERE action = 'purge.blocked'`,
					)
					.all() as Array<{
					org_id: string
					resource_type: string
					resource_id: string
					result: string
					details_json: string
				}>
			).map(({ details_json, ...row }) => ({
				...row,
				details: JSON.parse(details_json) as unknown,
			}))
		},
	}
}

let clockOffsetMs = 0

beforeEach(() => {
	clockOffsetMs = 0
	const realNow = Date.now.bind(Date)
	vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs)
	mocks.captureMessage.mockClear()
	mocks.hardPurgeOrg.mockReset()
	mocks.hardPurgeOrg.mockImplementation(deleteOrg)
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
})

afterEach(() => {
	vi.mocked(Date.now).mockRestore()
})

test('a claim whose lease expired is taken by another pass, and the stale pass stops', async () => {
	const h = createEnv()
	let takeover: Awaited<ReturnType<typeof pruneSoftDeleted>> | undefined
	mocks.hardPurgeOrg.mockImplementationOnce(
		async (input: HardPurgeOrgInput) => {
			// The first pass stalls past its lease without completing a step.
			takeover = await pruneSoftDeleted({
				env: h.env,
				now: later(purgeClaimLeaseMs + minuteMs),
			})
			await input.onStepComplete?.()
		},
	)

	const stale = await pruneSoftDeleted({ env: h.env, now })

	expect(takeover).toMatchObject({ scanned: 1, purged: 1, failed: 0 })
	expect(stale).toMatchObject({ scanned: 1, purged: 0, failed: 1 })
	expect(stale.outcomes[0]?.error).toContain('purge_claim_lost:orgs:org-claim')
	expect(mocks.hardPurgeOrg).toHaveBeenCalledTimes(2)
	expect(h.claimRow()).toBeUndefined()
})

test('renewing the lease after a completed step prevents takeover', async () => {
	const h = createEnv()
	let contender: Awaited<ReturnType<typeof pruneSoftDeleted>> | undefined
	mocks.hardPurgeOrg.mockImplementationOnce(
		async (input: HardPurgeOrgInput) => {
			clockOffsetMs = 10 * minuteMs
			await input.onStepComplete?.()
			const renewedMs =
				Date.parse(h.claimRow()?.purge_claim_until ?? '') - now.getTime()
			expect(renewedMs).toBeGreaterThanOrEqual(
				10 * minuteMs + purgeClaimLeaseMs,
			)
			expect(renewedMs).toBeLessThan(11 * minuteMs + purgeClaimLeaseMs)
			// Past the first lease end, inside the renewed one.
			contender = await pruneSoftDeleted({
				env: h.env,
				now: later(purgeClaimLeaseMs + 5 * minuteMs),
			})
			await input.onStepComplete?.()
			await deleteOrg(input)
		},
	)

	const owner = await pruneSoftDeleted({ env: h.env, now })

	expect(contender).toMatchObject({ scanned: 0, purged: 0, failed: 0 })
	expect(owner).toMatchObject({ scanned: 1, purged: 1, failed: 0 })
	expect(mocks.hardPurgeOrg).toHaveBeenCalledTimes(1)
	expect(h.claimRow()).toBeUndefined()
})

test('a failure keeps the claim behind a 24 hour fence and counts the attempt', async () => {
	const h = createEnv()
	mocks.hardPurgeOrg.mockRejectedValue(new Error('artifact cleanup failed'))

	expect(await pruneSoftDeleted({ env: h.env, now })).toMatchObject({
		failed: 1,
	})
	const fenced = h.claimRow()
	expect(fenced).toMatchObject({ purge_attempts: 1, purge_blocked_at: null })
	expect(fenced?.purge_claim_holder).toEqual(expect.any(String))
	const fenceMs = Date.parse(fenced?.purge_claim_until ?? '') - now.getTime()
	expect(fenceMs).toBeGreaterThanOrEqual(purgeClaimFailureFenceMs)
	expect(fenceMs).toBeLessThan(purgeClaimFailureFenceMs + minuteMs)

	// An expired lease is not enough: the fence holds for the full 24 hours.
	expect(
		await pruneSoftDeleted({ env: h.env, now: later(23 * hourMs) }),
	).toMatchObject({ scanned: 0, failed: 0 })
	expect(mocks.hardPurgeOrg).toHaveBeenCalledTimes(1)

	expect(
		await pruneSoftDeleted({ env: h.env, now: later(25 * hourMs) }),
	).toMatchObject({ scanned: 1, failed: 1 })
	expect(h.claimRow()?.purge_attempts).toBe(2)
	expect(h.blockedAudits()).toEqual([])
	expect(mocks.captureMessage).not.toHaveBeenCalled()
})

test('the 5th failure blocks the item, audits once, reports to Sentry once, and blocked items are skipped', async () => {
	const h = createEnv()
	mocks.hardPurgeOrg.mockRejectedValue(new Error('artifact cleanup failed'))

	for (let attempt = 1; attempt <= purgeClaimMaxAttempts; attempt += 1) {
		const pass = await pruneSoftDeleted({
			env: h.env,
			now: later((attempt - 1) * 25 * hourMs),
		})
		expect(pass).toMatchObject({ scanned: 1, failed: 1 })
		expect(h.claimRow()?.purge_attempts).toBe(attempt)
		expect(h.blockedAudits()).toHaveLength(
			attempt === purgeClaimMaxAttempts ? 1 : 0,
		)
	}
	expect(h.claimRow()?.purge_blocked_at).toEqual(expect.any(String))
	expect(h.blockedAudits()).toEqual([
		{
			org_id: orgId,
			resource_type: 'org',
			resource_id: orgId,
			result: 'failure',
			details: {
				kind: 'org',
				id: orgId,
				attempts: purgeClaimMaxAttempts,
				lastFailure: 'artifact cleanup failed',
				lane: 'soft_delete_purge',
			},
		},
	])
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	expect(mocks.captureMessage).toHaveBeenCalledWith(
		expect.stringContaining(`Purge blocked org ${orgId}`),
	)

	// Long past every lease and fence, a blocked item is never claimed again.
	for (const days of [7, 30]) {
		expect(
			await pruneSoftDeleted({ env: h.env, now: later(days * 24 * hourMs) }),
		).toMatchObject({ scanned: 0, purged: 0, failed: 0 })
	}
	expect(mocks.hardPurgeOrg).toHaveBeenCalledTimes(purgeClaimMaxAttempts)
	expect(h.claimRow()?.purge_attempts).toBe(purgeClaimMaxAttempts)
	expect(h.blockedAudits()).toHaveLength(1)
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
})
