vi.unmock('#worker/audit-log.ts')

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import * as AuditLog from '#worker/audit-log.ts'
import * as AccountDeletion from '#app/account-deletion.ts'
import * as DeletionState from '#worker/account/deletion-state.ts'
import {
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
} from '#app/account-deletion.ts'
import {
	listUnverifiedAccountPurgeCandidates,
	pruneUnverifiedAccounts,
} from './unverified-account-purge.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const now = new Date('2026-09-02T12:00:00.000Z')
const millisecondsPerDay = 24 * 60 * 60 * 1000

function daysAgo(days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function minutesAgo(minutes: number) {
	return new Date(now.getTime() - minutes * 60 * 1000).toISOString()
}

function emailHash(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

type SeededUser = Awaited<ReturnType<ReturnType<typeof createHarness>['seed']>>

const purged = (user: SeededUser, ageDays: number) => ({
	stableUserId: user.stableUserId,
	ageDays,
	outcome: 'purged',
})

const failed = (
	user: SeededUser,
	ageDays: number,
	error: string,
	warnings: Array<string> = [],
) => ({
	stableUserId: user.stableUserId,
	ageDays,
	outcome: 'failed',
	error,
	warnings,
})

const runResult = (
	counts: { scanned: number; purged: number; failed: number },
	outcomes: Array<object>,
) => ({ ...counts, timeBudgetExhausted: false, outcomes })

function withVerifyAfterUnverifiedAccountSelect(
	db: D1Database,
	verifiedAt: string,
): D1Database {
	const originalPrepare = db.prepare.bind(db)
	return {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			if (
				!query.includes(
					'SELECT id, stable_user_id, personal_org_id, email, created_at',
				)
			) {
				return statement
			}
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async all<T extends { id: number }>() {
							const result = await bound.all<T>()
							for (const row of result.results ?? []) {
								await originalPrepare(
									`UPDATE users SET email_verified_at = ? WHERE id = ?`,
								)
									.bind(verifiedAt, row.id)
									.run()
							}
							return result
						},
					}
				},
			}
		},
	} as D1Database
}

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL('../../audit-migrations/0001-audit-events.sql', import.meta.url),
			'utf8',
		),
	)
	const envFor = (appDb: D1Database) =>
		({
			...createSuccessfulDeletionEnv(appDb),
			AUDIT_DB: createD1FromSqlite(auditSqlite),
		}) as Env
	const env = envFor(db)
	return {
		sqlite,
		db,
		env,
		envFor,
		run(input: { batchSize?: number; timeBudgetMs?: number } = {}) {
			return pruneUnverifiedAccounts({ env, now, ...input })
		},
		async seed(
			username: string,
			createdDaysAgo: number,
			input: {
				email?: string
				emailVerifiedAt?: string
				deletingAt?: string
				oauthProvider?: string
				/** Set to insert this user's org. `null` is a creator-less org. */
				orgCreatedByUserId?: string | null
			} = {},
		) {
			const email = input.email ?? `${username}@example.com`
			const stableUserId = testStableUserIdFromEmail(email)
			const createdAt = daysAgo(createdDaysAgo)
			const inserted = sqlite
				.prepare(
					`INSERT INTO users (
						username, email, password_hash, stable_user_id,
						email_verified_at, deleting_at, created_at
					) VALUES (?, ?, 'hash', ?, ?, ?, ?)`,
				)
				.run(
					username,
					email,
					stableUserId,
					input.emailVerifiedAt ?? null,
					input.deletingAt ?? null,
					createdAt,
				)
			if (input.orgCreatedByUserId !== undefined) {
				sqlite
					.prepare(
						`INSERT INTO orgs (
							id, slug, created_by_user_id, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?)`,
					)
					.run(
						stableUserId,
						username,
						input.orgCreatedByUserId,
						createdAt,
						createdAt,
					)
			}
			const id = Number(inserted.lastInsertRowid)
			if (input.oauthProvider) {
				sqlite
					.prepare(
						`INSERT INTO oauth_connections (provider_name, provider_id, user_id)
						VALUES (?, ?, ?)`,
					)
					.run(input.oauthProvider, `${input.oauthProvider}-${id}`, id)
			}
			return { id, stableUserId, email, username }
		},
		usernames() {
			return (
				sqlite
					.prepare(`SELECT username FROM users ORDER BY username ASC`)
					.all() as Array<{ username: string }>
			).map((row) => row.username)
		},
		deletingAt(username: string) {
			const row = sqlite
				.prepare(`SELECT deleting_at FROM users WHERE username = ?`)
				.get(username) as { deleting_at: string | null } | undefined
			return row?.deleting_at ?? null
		},
		auditRows() {
			return auditSqlite
				.prepare(
					`SELECT category, action, result, email_hash, reason
					FROM audit_events
					ORDER BY id ASC`,
				)
				.all() as Array<{
				category: string
				action: string
				result: string
				email_hash: string | null
				reason: string | null
			}>
		},
	}
}

const purgedAudit = (user: SeededUser) =>
	expect.objectContaining({
		action: 'unverified_account_purged',
		email_hash: emailHash(user.email),
	})

const failedAudit = (user: SeededUser, reason: string | undefined) =>
	expect.objectContaining({
		action: 'unverified_account_purge_failed',
		result: 'failure',
		email_hash: emailHash(user.email),
		reason,
	})

const purgedStableIds = (spy: { mock: { calls: Array<Array<unknown>> } }) =>
	spy.mock.calls.map((call) => (call[0] as { mcpUserId: string }).mcpUserId)

test('purge deletes only aged unverified person accounts through full account deletion and writes an audit row', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const h = createHarness()
	const eligible = await h.seed('stale-unverified', 8)
	await h.seed('verified-old', 30, { emailVerifiedAt: daysAgo(29) })
	await h.seed('young-unverified', 1)
	await h.seed('platform-unverified', 30, { orgCreatedByUserId: null })
	await h.seed('fenced-unverified', 30, { deletingAt: minutesAgo(5) })
	await h.seed('social-unverified', 30, { oauthProvider: 'github' })

	expect(await h.run()).toEqual(
		runResult({ scanned: 1, purged: 1, failed: 0 }, [purged(eligible, 8)]),
	)
	expect(deleteUserAccount).toHaveBeenCalledTimes(1)
	expect(deleteUserAccount).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: h.db }),
		dbUserId: eligible.id,
		mcpUserId: eligible.stableUserId,
		personUserId: eligible.stableUserId,
	})
	expect(h.usernames()).toEqual([
		'fenced-unverified',
		'platform-unverified',
		'social-unverified',
		'verified-old',
		'young-unverified',
	])
	expect(h.auditRows()).toEqual([
		{
			category: 'account',
			action: 'unverified_account_purged',
			result: 'success',
			email_hash: emailHash(eligible.email),
			reason: 'unverified_for_8_days',
		},
	])
})

test('purge walks oldest-first keyset pages and stops at the bounded batch size', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const h = createHarness()
	const oldest = await h.seed('oldest', 11)
	const second = await h.seed('second', 10)
	const third = await h.seed('third', 9)
	const fourth = await h.seed('fourth', 8)

	expect(await h.run({ batchSize: 2 })).toEqual(
		runResult({ scanned: 2, purged: 2, failed: 0 }, [
			purged(oldest, 11),
			purged(second, 10),
		]),
	)
	expect(purgedStableIds(deleteUserAccount)).toEqual([
		oldest.stableUserId,
		second.stableUserId,
	])
	expect(h.usernames()).toEqual(['fourth', 'third'])

	deleteUserAccount.mockClear()
	expect((await h.run({ batchSize: 2 })).purged).toBe(2)
	expect(purgedStableIds(deleteUserAccount)).toEqual([
		third.stableUserId,
		fourth.stableUserId,
	])
	expect(h.usernames()).toEqual([])
	expect(h.auditRows()).toHaveLength(4)
})

test('a failed deletion is audited with a bounded reason, reported per account, and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const failing = await h.seed('failing', 12)
	const surviving = await h.seed('purged-after-failure', 11)
	const last = await h.seed('purged-last', 10)
	const inventoryWarnings = ['simulated inventory', 'second inventory warning']
	const inventoryError = 'AccountDeletionInventoryError: simulated inventory'
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(inventoryWarnings)
	})

	const result = await h.run()
	expect(result).toEqual(
		runResult({ scanned: 3, purged: 2, failed: 1 }, [
			failed(failing, 12, inventoryError, inventoryWarnings),
			purged(surviving, 11),
			purged(last, 10),
		]),
	)
	expect(JSON.stringify(result)).not.toContain('@example.com')
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: failing.stableUserId,
		warnings: inventoryWarnings,
		error: inventoryError,
	})
	expect(h.usernames()).toEqual(['failing'])
	expect(h.auditRows()).toEqual([
		{
			category: 'account',
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(failing.email),
			reason: inventoryError,
		},
		purgedAudit(surviving),
		expect.objectContaining({
			action: 'unverified_account_purged',
			reason: 'unverified_for_10_days',
		}),
	])
	expect(h.deletingAt('failing')).toBeNull()

	deleteUserAccount.mockClear()
	expect(await h.run()).toEqual(
		runResult({ scanned: 1, purged: 1, failed: 0 }, [purged(failing, 12)]),
	)
	expect(h.usernames()).toEqual([])
})

test('failure details redact email addresses before they reach outcomes, audit rows, or logs', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const leaky = await h.seed('leaky', 9, {
		email: 'leaky.person+tag@example.com',
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError([
			`Failed to enumerate Stripe customer id: no customer for ${leaky.email}`,
			`Failed to enumerate MCP servers: owner ${leaky.email} unreachable`,
		])
	})

	const result = await h.run()
	const [outcome] = result.outcomes
	expect(outcome).toEqual(
		failed(
			leaky,
			9,
			'AccountDeletionInventoryError: Failed to enumerate Stripe customer id: no customer for <email>',
			[
				'Failed to enumerate Stripe customer id: no customer for <email>',
				'Failed to enumerate MCP servers: owner <email> unreachable',
			],
		),
	)
	expect(JSON.stringify(result)).not.toContain('@example.com')
	const [auditRow] = h.auditRows()
	expect(auditRow).toMatchObject({
		action: 'unverified_account_purge_failed',
		reason: outcome?.error,
	})
	expect(JSON.stringify(auditRow)).not.toContain('@example.com')
	expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('@example.com')
})

test('a Stripe cancellation failure is a pre-cleanup failure: fence released, account retained, retried next run', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const billing = await h.seed('billing-failure', 12)
	const stripeWarning =
		'Stripe subscription sub_1 could not be canceled: Stripe API request failed with HTTP 503.'
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionBillingError([stripeWarning])
	})

	expect(await h.run()).toEqual(
		runResult({ scanned: 1, purged: 0, failed: 1 }, [
			failed(billing, 12, `AccountDeletionBillingError: ${stripeWarning}`, [
				stripeWarning,
			]),
		]),
	)
	expect(h.usernames()).toEqual(['billing-failure'])
	expect(h.deletingAt('billing-failure')).toBeNull()

	deleteUserAccount.mockClear()
	expect(await h.run()).toMatchObject({ scanned: 1, purged: 1, failed: 0 })
	expect(h.usernames()).toEqual([])
})

test('a failed failure-audit write is logged and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const logAuditEvent = vi.spyOn(AuditLog, 'logAuditEvent')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const failing = await h.seed('failing-audit-down', 12)
	const purgedUser = await h.seed('purged-after-audit-down', 11)
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(['simulated inventory'])
	})
	logAuditEvent.mockRejectedValueOnce(new Error('audit db down'))

	expect(await h.run()).toMatchObject({ scanned: 2, purged: 1, failed: 1 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_audit_failed',
		{ userId: failing.stableUserId, error: expect.any(Error) },
	)
	expect(h.usernames()).toEqual(['failing-audit-down'])
	expect(h.auditRows()).toEqual([purgedAudit(purgedUser)])
})

test('a failed fence release is logged and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const abortAccountDeleting = vi.spyOn(DeletionState, 'abortAccountDeleting')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const stuck = await h.seed('stuck-fence', 12)
	const afterStuck = await h.seed('purged-after-stuck', 11)
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(['simulated inventory'])
	})
	abortAccountDeleting.mockImplementationOnce(async () => {
		throw new Error('simulated release failure')
	})

	expect(await h.run()).toEqual(
		runResult({ scanned: 2, purged: 1, failed: 1 }, [
			failed(stuck, 12, 'AccountDeletionInventoryError: simulated inventory', [
				'simulated inventory',
			]),
			purged(afterStuck, 11),
		]),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_release_failed',
		{ userId: stuck.stableUserId, error: expect.any(Error) },
	)
	expect(h.usernames()).toEqual(['stuck-fence'])
	expect(h.deletingAt('stuck-fence')).not.toBeNull()
})

async function expectFailureKeepsFence(
	h: ReturnType<typeof createHarness>,
	user: SeededUser,
	ageDays: number,
	message: string,
	warnings: Array<string>,
) {
	expect(await h.run()).toEqual(
		runResult({ scanned: 1, purged: 0, failed: 1 }, [
			failed(user, ageDays, message, warnings),
		]),
	)
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: user.stableUserId,
		warnings,
		error: message,
	})
	expect(h.usernames()).toEqual([user.username])
	expect(h.deletingAt(user.username)).not.toBeNull()
	expect(h.auditRows()).toEqual([failedAudit(user, message)])
}

test('a pre-existing fence is left in place when a restamped deletion fails', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const fenced = await h.seed('restamp-fail', 12, { deletingAt: daysAgo(1) })
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new Error('simulated restamped deletion failure')
	})

	await expectFailureKeepsFence(
		h,
		fenced,
		12,
		'Error: simulated restamped deletion failure',
		[],
	)
	expect(deleteUserAccount).toHaveBeenCalledTimes(1)
})

test('a cleanup error keeps a claim-created fence so the damaged account retries', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const damaged = await h.seed('cleanup-fail', 8)
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionCleanupError(['simulated cleanup'], {
			deletedRowCounts: {},
			updatedRowCounts: {},
			deletedKvKeys: 0,
			deletedCommunityAssets: 0,
			deletedEmailBlobs: 0,
			deletedArtifactRepos: 0,
			revokedOAuthGrants: 0,
			clearedDurableObjects: {},
			deletedVectors: 0,
			stripeRefunds: [],
			warnings: ['simulated cleanup'],
		})
	})

	await expectFailureKeepsFence(
		h,
		damaged,
		8,
		'AccountDeletionCleanupError: simulated cleanup',
		['simulated cleanup'],
	)

	deleteUserAccount.mockClear()
	expect(await h.run()).toEqual(
		runResult({ scanned: 0, purged: 0, failed: 0 }, []),
	)
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(h.usernames()).toEqual(['cleanup-fail'])
})

test('an audit failure after a successful delete does not stop the batch or release a fence', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const logAuditEvent = vi.spyOn(AuditLog, 'logAuditEvent')
	consoleWarn.mockImplementation(() => {})
	const h = createHarness()
	const first = await h.seed('audit-fail', 10)
	const second = await h.seed('audit-ok', 9)
	logAuditEvent.mockRejectedValueOnce(new Error('audit db down'))

	expect(await h.run()).toEqual(
		runResult({ scanned: 2, purged: 2, failed: 0 }, [
			purged(first, 10),
			purged(second, 9),
		]),
	)
	expect(deleteUserAccount).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_audit_failed',
		{ userId: first.stableUserId, error: expect.any(Error) },
	)
	expect(h.usernames()).toEqual([])
	expect(h.auditRows()).toEqual([purgedAudit(second)])
})

test('a claim that loses the race to verification keeps the account and writes no audit', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const h = createHarness()
	const raced = await h.seed('verified-during-select', 8)
	const env = h.envFor(
		withVerifyAfterUnverifiedAccountSelect(h.db, now.toISOString()),
	)

	expect(await pruneUnverifiedAccounts({ env, now })).toEqual(
		runResult({ scanned: 1, purged: 0, failed: 0 }, [
			{
				stableUserId: raced.stableUserId,
				ageDays: 8,
				outcome: 'skipped_claim',
			},
		]),
	)
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(h.usernames()).toEqual(['verified-during-select'])
	expect(h.auditRows()).toEqual([])
	expect(
		h.sqlite
			.prepare(
				`SELECT email_verified_at IS NOT NULL AS verified, deleting_at FROM users WHERE id = ?`,
			)
			.get(raced.id),
	).toEqual({ verified: 1, deleting_at: null })
})

test('never-attempted accounts are purged before stale fences; in-backoff fences are skipped', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const h = createHarness()
	const staleFence = await h.seed('stale-fence', 30, { deletingAt: daysAgo(1) })
	const fresh = await h.seed('fresh-unverified', 8)
	await h.seed('recent-fence', 20, { deletingAt: minutesAgo(5) })

	expect(await h.run({ batchSize: 1 })).toEqual(
		runResult({ scanned: 1, purged: 1, failed: 0 }, [purged(fresh, 8)]),
	)
	expect(purgedStableIds(deleteUserAccount)).toEqual([fresh.stableUserId])
	expect(h.usernames()).toEqual(['recent-fence', 'stale-fence'])

	deleteUserAccount.mockClear()
	expect(await h.run({ batchSize: 2 })).toEqual(
		runResult({ scanned: 1, purged: 1, failed: 0 }, [purged(staleFence, 30)]),
	)
	expect(purgedStableIds(deleteUserAccount)).toEqual([staleFence.stableUserId])
	expect(h.usernames()).toEqual(['recent-fence'])
	expect(h.deletingAt('recent-fence')).not.toBeNull()
	expect(h.auditRows()).toHaveLength(2)
})

test('a zero time budget deletes nothing', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const h = createHarness()
	await h.seed('would-purge', 8)

	expect(await h.run({ timeBudgetMs: 0 })).toEqual({
		scanned: 1,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: true,
		outcomes: [],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(h.usernames()).toEqual(['would-purge'])
	expect(h.deletingAt('would-purge')).toBeNull()
	expect(h.auditRows()).toEqual([])
})

test('listUnverifiedAccountPurgeCandidates previews the claim page without claiming, deleting, or auditing', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const h = createHarness()
	const staleFence = await h.seed('preview-stale-fence', 30, {
		deletingAt: daysAgo(1),
	})
	const fresh = await h.seed('preview-fresh', 9)
	await h.seed('preview-young', 2)
	await h.seed('preview-recent-fence', 20, { deletingAt: minutesAgo(5) })
	const preview = (batchSize?: number) =>
		listUnverifiedAccountPurgeCandidates({ env: h.env, now, batchSize })

	const page = await preview()
	expect(page).toEqual({
		scanned: 2,
		candidates: [
			{ stableUserId: fresh.stableUserId, ageDays: 9 },
			{ stableUserId: staleFence.stableUserId, ageDays: 30 },
		],
	})
	expect(JSON.stringify(page)).not.toContain('@example.com')
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(h.deletingAt('preview-fresh')).toBeNull()
	expect(h.deletingAt('preview-stale-fence')).toBe(daysAgo(1))
	expect(h.auditRows()).toEqual([])
	expect(await preview(1)).toEqual({
		scanned: 1,
		candidates: [{ stableUserId: fresh.stableUserId, ageDays: 9 }],
	})
})
