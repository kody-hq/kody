/**
 * soft-delete-read-filter: opt-out
 *
 * Purge scans and claims unverified person accounts, including rows already
 * soft-deleted or mid-deletion.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { invalidatePackageAppOwnerCacheForDbUserId } from '#app/package-app-owner.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import * as Sentry from '@sentry/cloudflare'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	AccountDeletionWritersActiveError,
	abortAccountDeleting,
} from '#worker/account/deletion-state.ts'
import {
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
} from '#app/account-deletion.ts'

export { shouldRunRetentionCron as shouldRunUnverifiedAccountPurgeCron }

export const unverifiedAccountPurgeDays = 7
export const unverifiedAccountPurgeBatchSize = 5
/**
 * Total wall-clock budget for one unverified-account purge run. Matches the
 * retention lane: each hourly tick deletes bounded batches until the eligible
 * set is drained or this budget is exhausted.
 */
export const unverifiedAccountPurgeRunTimeBudgetMs = 20_000
/**
 * Skip rows whose `deleting_at` is newer than this window. Each claim restamps
 * `deleting_at`, so a failed deletion retries after this backoff instead of
 * every hourly tick or never.
 */
export const unverifiedAccountPurgeRetryBackoffMs = 6 * 60 * 60 * 1000
/**
 * Upper bound for the compact failure reason written to the audit row and
 * returned in per-account outcomes: `<ErrorName>: <first warning or message>`.
 */
export const unverifiedAccountPurgeFailureReasonMaxLength = 200

const millisecondsPerDay = 24 * 60 * 60 * 1000

const unverifiedPersonEligibilitySql = [
	'email_verified_at IS NULL',
	// Leftover platform accounts are ordinary orgs whose creator is null.
	// They never complete email login, so this unverified sweep would delete
	// those users rows. A missing org row stays eligible: person signups
	// always set created_by_user_id.
	`NOT EXISTS (
			SELECT 1
			FROM orgs
			WHERE orgs.id = COALESCE(NULLIF(TRIM(users.personal_org_id), ''), users.stable_user_id)
				AND orgs.created_by_user_id IS NULL
		)`,
	// Exempting any oauth_connections row is sound only because signed-in
	// linking requires a live verified email (the insert is fenced on
	// email_verified_at IS NOT NULL) and unauthenticated social sign-in
	// always verifies. A password squat cannot attach a provider to skip
	// this purge.
	`NOT EXISTS (
			SELECT 1
			FROM oauth_connections
			WHERE oauth_connections.user_id = users.id
		)`,
] as const

type UnverifiedAccountRow = {
	id: number
	stable_user_id: OwnerId
	personal_org_id: string | null
	email: string
	created_at: string
}

type UnverifiedAccountClaim =
	| { claimed: false }
	| { claimed: true; created: boolean; deletingAt: string }

export type UnverifiedAccountPurgeOutcomeKind =
	| 'purged'
	| 'failed'
	| 'skipped_claim'

/**
 * Per-account result of one purge pass. Identifies the account by stable id
 * only; emails and usernames never leave the lane.
 */
export type UnverifiedAccountPurgeOutcome = {
	stableUserId: OwnerId
	ageDays: number
	outcome: UnverifiedAccountPurgeOutcomeKind
	error?: string
	warnings?: Array<string>
}

export type UnverifiedAccountPurgeResult = {
	scanned: number
	purged: number
	failed: number
	timeBudgetExhausted: boolean
	outcomes: Array<UnverifiedAccountPurgeOutcome>
}

export type UnverifiedAccountPurgeCandidate = {
	stableUserId: OwnerId
	ageDays: number
}

function cutoffIso(now: Date, millisecondsAgo: number) {
	return new Date(now.getTime() - millisecondsAgo).toISOString()
}

function purgeCutoffs(now: Date) {
	return {
		ageCutoff: cutoffIso(now, unverifiedAccountPurgeDays * millisecondsPerDay),
		retryBackoffCutoff: cutoffIso(now, unverifiedAccountPurgeRetryBackoffMs),
	}
}

function unverifiedAccountSqlConditions() {
	return [
		...unverifiedPersonEligibilitySql,
		'datetime(created_at) < datetime(?)',
		'(deleting_at IS NULL OR datetime(deleting_at) < datetime(?))',
	] as const
}

const emailAddressPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Deletion errors bubble up provider and D1 messages that can quote the
 * account's email. Everything that leaves this module (audit reasons, admin
 * outcomes, logs, Sentry) passes through here first.
 */
export function redactEmailAddresses(text: string) {
	return text.replace(emailAddressPattern, '<email>')
}

function deletionFailureWarnings(error: unknown) {
	if (error instanceof AccountDeletionCleanupError) {
		return error.cleanupErrors.map(redactEmailAddresses)
	}
	if (error instanceof AccountDeletionInventoryError) {
		return error.inventoryErrors.map(redactEmailAddresses)
	}
	if (error instanceof AccountDeletionBillingError) {
		return error.billingErrors.map(redactEmailAddresses)
	}
	return []
}

function errorConstructorName(error: unknown) {
	if (typeof error === 'object' && error !== null) {
		const name = error.constructor?.name
		if (typeof name === 'string' && name.length > 0) return name
	}
	return 'UnknownError'
}

/**
 * Compact, bounded description of why a deletion failed. Shape is
 * `<ErrorClassName>: <first inventory/cleanup warning, else error.message>`
 * truncated to `unverifiedAccountPurgeFailureReasonMaxLength` characters.
 */
function unverifiedAccountPurgeFailureReason(
	error: unknown,
	warnings: ReadonlyArray<string>,
) {
	const detail =
		warnings[0] ??
		(error instanceof Error && error.message.length > 0
			? error.message
			: String(error))
	return redactEmailAddresses(`${errorConstructorName(error)}: ${detail}`)
		.replace(/\s+/g, ' ')
		.slice(0, unverifiedAccountPurgeFailureReasonMaxLength)
}

/**
 * Same class name and stack as the original so Sentry groups it, but with the
 * message (which may quote provider responses) redacted.
 */
function redactedErrorForReporting(error: unknown) {
	if (!(error instanceof Error)) {
		return new Error(redactEmailAddresses(String(error)))
	}
	const redacted = new Error(redactEmailAddresses(error.message))
	redacted.name = error.name
	redacted.stack = error.stack ? redactEmailAddresses(error.stack) : undefined
	return redacted
}

function reportPurgeFailureToSentry(input: {
	error: unknown
	userId: OwnerId
	warnings: ReadonlyArray<string>
}) {
	try {
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return
		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('scheduled.lane', 'unverified_account_purge')
			// Stable id only: sendDefaultPii is false and emails stay out of Sentry.
			scope.setContext('unverified_account_purge', {
				userId: input.userId,
				warnings: [...input.warnings],
			})
			Sentry.captureException(redactedErrorForReporting(input.error))
		})
	} catch (sentryError) {
		console.warn('unverified_account_purge_sentry_failed', {
			userId: input.userId,
			error: sentryError,
		})
	}
}

function isPreCleanupDeletionFailure(error: unknown) {
	return (
		error instanceof AccountDeletionInventoryError ||
		error instanceof AccountDeletionBillingError ||
		error instanceof AccountDeletionWritersActiveError
	)
}

function ageDays(createdAt: string, now: Date) {
	const createdMs = Date.parse(
		createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`,
	)
	if (!Number.isFinite(createdMs)) return unverifiedAccountPurgeDays
	return Math.floor((now.getTime() - createdMs) / millisecondsPerDay)
}

async function listUnverifiedAccountsPage(input: {
	db: D1Database
	ageCutoff: string
	retryBackoffCutoff: string
	batchSize: number
}) {
	const conditions = unverifiedAccountSqlConditions().join('\n			AND ')
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(
				`SELECT id, stable_user_id, personal_org_id, email, created_at
				FROM users
				WHERE ${conditions}
				ORDER BY (deleting_at IS NULL) DESC, datetime(created_at) ASC, id ASC
				LIMIT ?`,
			)
			.bind(input.ageCutoff, input.retryBackoffCutoff, input.batchSize)
			.all<UnverifiedAccountRow>(),
	)
	return results ?? []
}

async function claimUnverifiedAccountForPurge(input: {
	db: D1Database
	dbUserId: number
	now: Date
	retryBackoffCutoff: string
}): Promise<UnverifiedAccountClaim> {
	const deletingAt = utcSqliteTimestamp(input.now)
	const eligibility = unverifiedPersonEligibilitySql.join('\n					AND ')
	const createdResult = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				SET deleting_at = ?, updated_at = ?
				WHERE id = ?
					AND ${eligibility}
					AND deleting_at IS NULL`,
			)
			.bind(deletingAt, deletingAt, input.dbUserId)
			.run(),
	)
	if ((createdResult.meta.changes ?? 0) === 1) {
		await invalidatePackageAppOwnerCacheForDbUserId(input.db, input.dbUserId)
		return { claimed: true, created: true, deletingAt }
	}
	const restampedResult = await runD1WithRetry(() =>
		input.db
			.prepare(
				`UPDATE users
				SET deleting_at = ?, updated_at = ?
				WHERE id = ?
					AND ${eligibility}
					AND datetime(deleting_at) < datetime(?)`,
			)
			.bind(deletingAt, deletingAt, input.dbUserId, input.retryBackoffCutoff)
			.run(),
	)
	if ((restampedResult.meta.changes ?? 0) === 1) {
		await invalidatePackageAppOwnerCacheForDbUserId(input.db, input.dbUserId)
		return { claimed: true, created: false, deletingAt }
	}
	return { claimed: false }
}

/**
 * Read-only preview of the next purge page: the accounts one run would try
 * to claim right now, in claim order. Performs no claims and no deletes.
 */
export async function listUnverifiedAccountPurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<{
	scanned: number
	candidates: Array<UnverifiedAccountPurgeCandidate>
}> {
	const now = input.now ?? new Date()
	const page = await listUnverifiedAccountsPage({
		db: input.env.APP_DB,
		...purgeCutoffs(now),
		batchSize: input.batchSize ?? unverifiedAccountPurgeBatchSize,
	})
	return {
		scanned: page.length,
		candidates: page.map((account) => ({
			stableUserId: account.stable_user_id,
			ageDays: ageDays(account.created_at, now),
		})),
	}
}

export async function pruneUnverifiedAccounts(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
}): Promise<UnverifiedAccountPurgeResult> {
	const now = input.now ?? new Date()
	const startedAtMs = Date.now()
	const timeBudgetMs =
		input.timeBudgetMs ?? unverifiedAccountPurgeRunTimeBudgetMs
	const batchSize = input.batchSize ?? unverifiedAccountPurgeBatchSize
	const { ageCutoff, retryBackoffCutoff } = purgeCutoffs(now)
	const result: UnverifiedAccountPurgeResult = {
		scanned: 0,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [],
	}
	const page = await listUnverifiedAccountsPage({
		db: input.env.APP_DB,
		ageCutoff,
		retryBackoffCutoff,
		batchSize,
	})
	result.scanned = page.length
	for (const account of page) {
		if (Date.now() - startedAtMs >= timeBudgetMs) {
			result.timeBudgetExhausted = true
			break
		}
		const accountAgeDays = ageDays(account.created_at, now)
		const claim = await claimUnverifiedAccountForPurge({
			db: input.env.APP_DB,
			dbUserId: account.id,
			now,
			retryBackoffCutoff,
		})
		if (!claim.claimed) {
			result.outcomes.push({
				stableUserId: account.stable_user_id,
				ageDays: accountAgeDays,
				outcome: 'skipped_claim',
			})
			continue
		}
		try {
			await deleteUserAccount({
				env: input.env,
				dbUserId: account.id,
				mcpUserId: personalOrgIdFromUserRow({
					personal_org_id: account.personal_org_id,
					stable_user_id: account.stable_user_id,
				}),
				personUserId: account.stable_user_id,
			})
			try {
				await logAuditEvent({
					db: auditDatabaseFromEnv(input.env),
					category: 'account',
					action: 'unverified_account_purged',
					result: 'success',
					email: account.email,
					reason: `unverified_for_${accountAgeDays}_days`,
				})
			} catch (error) {
				console.warn('unverified_account_purge_audit_failed', {
					userId: account.stable_user_id,
					error,
				})
			}
			result.purged += 1
			result.outcomes.push({
				stableUserId: account.stable_user_id,
				ageDays: accountAgeDays,
				outcome: 'purged',
			})
		} catch (error) {
			if (claim.created && isPreCleanupDeletionFailure(error)) {
				// A failed release leaves the fence in place; the retry backoff
				// restamps it later, so it must not abort the rest of the batch.
				try {
					await abortAccountDeleting({
						db: input.env.APP_DB,
						dbUserId: account.id,
						env: input.env,
						expectedDeletingAt: claim.deletingAt,
					})
				} catch (releaseError) {
					console.warn('unverified_account_purge_release_failed', {
						userId: account.stable_user_id,
						error: releaseError,
					})
				}
			}
			result.failed += 1
			const warnings = deletionFailureWarnings(error)
			const reason = unverifiedAccountPurgeFailureReason(error, warnings)
			result.outcomes.push({
				stableUserId: account.stable_user_id,
				ageDays: accountAgeDays,
				outcome: 'failed',
				error: reason,
				warnings: [...warnings],
			})
			console.warn('unverified_account_purge_failed', {
				userId: account.stable_user_id,
				warnings,
				error: reason,
			})
			// Workers Logs sampling drops most of the warn above; the audit row
			// and Sentry event are the best-effort durable record of why the
			// purge failed (each is skipped, not fatal, when its sink is down).
			try {
				await logAuditEvent({
					db: auditDatabaseFromEnv(input.env),
					category: 'account',
					action: 'unverified_account_purge_failed',
					result: 'failure',
					email: account.email,
					reason,
				})
			} catch (auditError) {
				console.warn('unverified_account_purge_audit_failed', {
					userId: account.stable_user_id,
					error: auditError,
				})
			}
			reportPurgeFailureToSentry({
				error,
				userId: account.stable_user_id,
				warnings,
			})
		}
	}
	console.info('unverified-account-purge', JSON.stringify(result))
	return result
}
