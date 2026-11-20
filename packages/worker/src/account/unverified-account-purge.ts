/**
 * soft-delete-read-filter: opt-out
 *
 * Purge scans and claims live unverified person accounts, including rows
 * mid-deletion (`deleting_at` set), and its platform-account exemption reads
 * `orgs` rows whether or not they are soft-deleted.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { invalidatePackageAppOwnerCacheForDbUserId } from '#app/package-app-owner.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import * as Sentry from '@sentry/cloudflare'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { z } from 'zod'
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
import { type Clock, systemClock } from '#worker/scheduled/retention/clock.ts'
import { startPassBudget } from '#worker/scheduled/retention/budget.ts'
import { runClaimed } from '#worker/scheduled/retention/claim.ts'
import {
	type BlockedPurgeItem,
	holdPurgeLease,
	type PurgeLease,
	purgeClaimableSql,
	purgeLeaseExpiresAt,
	recordFailedPurgeAttempt,
} from '#worker/scheduled/retention/purge-lease.ts'
import {
	d1All,
	d1Run,
	type RetentionContext,
} from '#worker/scheduled/retention/d1.ts'
import { assertNever } from '#worker/scheduled/retention/failures.ts'
import {
	dbIdColumn,
	ownerIdColumn,
	timestampColumn,
} from '#worker/scheduled/retention/rows.ts'
import { traced } from '#worker/scheduled/retention/telemetry.ts'

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
 * Skip rows whose `deleting_at` is newer than this window when no purge claim
 * wrote it (an account deletion in flight, a claim from before leases). Purge
 * claims use the lease and failure fence in `purge-lease.ts` instead.
 */
export const unverifiedAccountPurgeRetryBackoffMs = 6 * 60 * 60 * 1000
/**
 * Upper bound for the compact failure reason written to the audit row and
 * returned in per-account outcomes: `<ErrorName>: <first warning or message>`.
 */
export const unverifiedAccountPurgeFailureReasonMaxLength = 200

const millisecondsPerDay = 24 * 60 * 60 * 1000

const unverifiedPersonEligibilitySql = [
	// Soft-deleted accounts keep their restore window; the soft-delete purge
	// lane (orgs/purge.ts) owns hard-deleting them once it ends.
	'users.deleted_at IS NULL',
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

const unverifiedAccountRow = z.object({
	id: dbIdColumn,
	stable_user_id: ownerIdColumn,
	personal_org_id: z.string().nullable(),
	email: z.string(),
	created_at: timestampColumn,
})

type UnverifiedAccountRow = z.output<typeof unverifiedAccountRow>

/** `created` is true when this pass set the fence (vs. restamping a stale one). */
type UnverifiedAccountClaim = {
	created: boolean
	deletingAt: string
	lease: PurgeLease
}

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
	/** This failure was the last allowed attempt; no lane claims it again. */
	blocked?: true
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

function purgeCutoffs(now: Date, clock: Clock) {
	return {
		ageCutoff: cutoffIso(now, unverifiedAccountPurgeDays * millisecondsPerDay),
		leaseNow: clock.now().toISOString(),
		retryBackoffCutoff: cutoffIso(now, unverifiedAccountPurgeRetryBackoffMs),
	}
}

function unverifiedAccountSqlConditions() {
	return [
		...unverifiedPersonEligibilitySql,
		'datetime(created_at) < datetime(?)',
		purgeClaimableSql,
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

function listUnverifiedAccountsPage(
	ctx: RetentionContext,
	input: {
		ageCutoff: string
		leaseNow: string
		retryBackoffCutoff: string
		batchSize: number
	},
) {
	const conditions = unverifiedAccountSqlConditions().join('\n			AND ')
	return d1All(ctx, {
		operation: 'unverified_account_purge.list_candidates',
		sql: `SELECT id, stable_user_id, personal_org_id, email, created_at
			FROM users
			WHERE ${conditions}
			ORDER BY (deleting_at IS NULL) DESC, datetime(created_at) ASC, id ASC
			LIMIT ?`,
		bindings: [
			input.ageCutoff,
			input.leaseNow,
			input.retryBackoffCutoff,
			input.batchSize,
		],
		row: unverifiedAccountRow,
	})
}

/**
 * Claims by stamping `deleting_at` and a 15 minute lease: a never-fenced row
 * first, else a claimable fence (`purgeClaimableSql`). The eligibility
 * predicate is repeated so a row that was verified or soft-deleted since the
 * scan is not claimed.
 */
async function claimUnverifiedAccountForPurge(
	ctx: RetentionContext,
	input: { dbUserId: number; now: Date; retryBackoffCutoff: string },
): Promise<UnverifiedAccountClaim | null> {
	const deletingAt = utcSqliteTimestamp(input.now)
	const leaseExpiresAt = purgeLeaseExpiresAt(ctx.clock)
	const eligibility = unverifiedPersonEligibilitySql.join('\n				AND ')
	const claim = (fenceFilter: string) =>
		d1Run(ctx, {
			operation: 'unverified_account_purge.claim',
			sql: `UPDATE users
				SET deleting_at = ?, purge_lease_expires_at = ?, updated_at = ?
				WHERE id = ?
					AND ${eligibility}
					AND ${fenceFilter}
					AND ${purgeClaimableSql}`,
			bindings: [
				deletingAt,
				leaseExpiresAt,
				deletingAt,
				input.dbUserId,
				ctx.clock.now().toISOString(),
				input.retryBackoffCutoff,
			],
		})
	let created = true
	if ((await claim('deleting_at IS NULL')) !== 1) {
		created = false
		if ((await claim('deleting_at IS NOT NULL')) !== 1) return null
	}
	await invalidatePackageAppOwnerCacheForDbUserId(ctx.db, input.dbUserId)
	const lease = holdPurgeLease(
		ctx,
		{ table: 'users', idColumn: 'id', id: input.dbUserId },
		leaseExpiresAt,
	)
	return { created, deletingAt, lease }
}

/**
 * Read-only preview of the next purge page: the accounts one run would try
 * to claim right now, in claim order. Performs no claims and no deletes.
 */
export function listUnverifiedAccountPurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
	clock?: Clock
	signal?: AbortSignal
}): Promise<{
	scanned: number
	candidates: Array<UnverifiedAccountPurgeCandidate>
}> {
	const clock = input.clock ?? systemClock
	return traced(
		'retention.unverified_account_purge.list_candidates',
		{},
		async () => {
			const now = input.now ?? clock.now()
			const page = await listUnverifiedAccountsPage(
				{ db: input.env.APP_DB, clock, signal: input.signal },
				{
					...purgeCutoffs(now, clock),
					batchSize: input.batchSize ?? unverifiedAccountPurgeBatchSize,
				},
			)
			return {
				scanned: page.length,
				candidates: page.map((account) => ({
					stableUserId: account.stable_user_id,
					ageDays: ageDays(account.created_at, now),
				})),
			}
		},
		clock,
	)
}

/** Best-effort audit write: a failing sink is logged, never fatal. */
async function writePurgeAudit(input: {
	env: Env
	account: UnverifiedAccountRow
	action: 'unverified_account_purged' | 'unverified_account_purge_failed'
	reason: string
}) {
	try {
		await logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'account',
			action: input.action,
			result:
				input.action === 'unverified_account_purged' ? 'success' : 'failure',
			email: input.account.email,
			reason: input.reason,
		})
	} catch (error) {
		console.warn('unverified_account_purge_audit_failed', {
			userId: input.account.stable_user_id,
			error,
		})
	}
}

function writePurgeBlockedAudit(
	env: Env,
	account: UnverifiedAccountRow,
	item: BlockedPurgeItem,
) {
	return logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'purge.blocked',
		result: 'failure',
		email: account.email,
		reason: JSON.stringify({
			kind: item.kind,
			id: item.id,
			attempts: item.attempts,
			lastFailure: item.lastFailure,
		}),
	})
}

async function recordPurgeFailure(input: {
	env: Env
	account: UnverifiedAccountRow
	ageDays: number
	error: unknown
	lease: PurgeLease | null
}): Promise<UnverifiedAccountPurgeOutcome> {
	const warnings = deletionFailureWarnings(input.error)
	const reason = unverifiedAccountPurgeFailureReason(input.error, warnings)
	console.warn('unverified_account_purge_failed', {
		userId: input.account.stable_user_id,
		warnings,
		error: reason,
	})
	// Workers Logs sampling drops most of the warn above; the audit row and
	// Sentry event are the best-effort durable record of why the purge failed
	// (each is skipped, not fatal, when its sink is down).
	await writePurgeAudit({
		env: input.env,
		account: input.account,
		action: 'unverified_account_purge_failed',
		reason,
	})
	reportPurgeFailureToSentry({
		error: input.error,
		userId: input.account.stable_user_id,
		warnings,
	})
	const { blocked } = input.lease
		? await recordFailedPurgeAttempt({
				lease: input.lease,
				item: {
					lane: 'unverified_account_purge',
					kind: 'user',
					id: input.account.stable_user_id,
					lastFailure: reason,
				},
				writeBlockedAudit: (item) =>
					writePurgeBlockedAudit(input.env, input.account, item),
			})
		: { blocked: false }
	return {
		stableUserId: input.account.stable_user_id,
		ageDays: input.ageDays,
		outcome: 'failed',
		error: reason,
		warnings: [...warnings],
		...(blocked ? { blocked: true as const } : {}),
	}
}

function purgeOneAccount(input: {
	env: Env
	ctx: RetentionContext
	account: UnverifiedAccountRow
	now: Date
	retryBackoffCutoff: string
}): Promise<UnverifiedAccountPurgeOutcome> {
	const { account, env } = input
	const accountAgeDays = ageDays(account.created_at, input.now)
	return traced(
		'retention.unverified_account_purge.account',
		{ 'retention.age_days': accountAgeDays },
		async (span) => {
			const held: { lease: PurgeLease | null } = { lease: null }
			const outcome = await runClaimed({
				acquire: async () => {
					const claim = await claimUnverifiedAccountForPurge(input.ctx, {
						dbUserId: account.id,
						now: input.now,
						retryBackoffCutoff: input.retryBackoffCutoff,
					})
					held.lease = claim?.lease ?? null
					return claim
				},
				body: () =>
					deleteUserAccount({
						env,
						dbUserId: account.id,
						mcpUserId: personalOrgIdFromUserRow({
							personal_org_id: account.personal_org_id,
							stable_user_id: account.stable_user_id,
						}),
						personUserId: account.stable_user_id,
					}),
				// Only a fence this pass created, for a failure before any data was
				// removed, releases `deleting_at`. Every failure keeps the claim's
				// 24 hour failure fence, written by `recordFailedPurgeAttempt`.
				onFailure: (claim, error) =>
					claim.created && isPreCleanupDeletionFailure(error)
						? 'release'
						: 'keep',
				release: (claim) =>
					abortAccountDeleting({
						db: env.APP_DB,
						dbUserId: account.id,
						env,
						expectedDeletingAt: claim.deletingAt,
					}),
			})
			span.setAttribute('retention.outcome', outcome.status)
			switch (outcome.status) {
				case 'not_claimed':
					return {
						stableUserId: account.stable_user_id,
						ageDays: accountAgeDays,
						outcome: 'skipped_claim',
					}
				case 'completed':
					await writePurgeAudit({
						env,
						account,
						action: 'unverified_account_purged',
						reason: `unverified_for_${accountAgeDays}_days`,
					})
					return {
						stableUserId: account.stable_user_id,
						ageDays: accountAgeDays,
						outcome: 'purged',
					}
				case 'failed':
					span.setAttribute('retention.claim', outcome.disposition)
					if (outcome.disposition === 'release_failed') {
						// `deleting_at` stays; the failure fence paces the retry.
						console.warn('unverified_account_purge_release_failed', {
							userId: account.stable_user_id,
							error: outcome.releaseError,
						})
					}
					return recordPurgeFailure({
						env,
						account,
						ageDays: accountAgeDays,
						error: outcome.error,
						lease: held.lease,
					})
				default:
					return assertNever(outcome)
			}
		},
		input.ctx.clock,
	)
}

export function pruneUnverifiedAccounts(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
	clock?: Clock
	signal?: AbortSignal
}): Promise<UnverifiedAccountPurgeResult> {
	const clock = input.clock ?? systemClock
	return traced(
		'retention.unverified_account_purge',
		{},
		async (span) => {
			const now = input.now ?? clock.now()
			const budget = startPassBudget(
				clock,
				input.timeBudgetMs ?? unverifiedAccountPurgeRunTimeBudgetMs,
			)
			const batchSize = input.batchSize ?? unverifiedAccountPurgeBatchSize
			const { ageCutoff, leaseNow, retryBackoffCutoff } = purgeCutoffs(
				now,
				clock,
			)
			const ctx = { db: input.env.APP_DB, clock, signal: input.signal }
			const result: UnverifiedAccountPurgeResult = {
				scanned: 0,
				purged: 0,
				failed: 0,
				timeBudgetExhausted: false,
				outcomes: [],
			}
			const page = await listUnverifiedAccountsPage(ctx, {
				ageCutoff,
				leaseNow,
				retryBackoffCutoff,
				batchSize,
			})
			result.scanned = page.length
			for (const account of page) {
				if (budget.reached()) {
					result.timeBudgetExhausted = true
					break
				}
				const outcome = await purgeOneAccount({
					env: input.env,
					ctx,
					account,
					now,
					retryBackoffCutoff,
				})
				if (outcome.outcome === 'purged') result.purged += 1
				if (outcome.outcome === 'failed') result.failed += 1
				result.outcomes.push(outcome)
			}
			span.setAttribute('retention.scanned', result.scanned)
			span.setAttribute('retention.purged', result.purged)
			span.setAttribute('retention.failed', result.failed)
			span.setAttribute(
				'retention.budget_exhausted',
				result.timeBudgetExhausted,
			)
			console.info('unverified-account-purge', JSON.stringify(result))
			return result
		},
		clock,
	)
}
