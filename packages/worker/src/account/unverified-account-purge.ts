/**
 * soft-delete-read-filter: opt-out
 *
 * Purge scans and claims live unverified person accounts, including rows
 * mid-deletion (`deleting_at` set), and its platform-account exemption reads
 * `orgs` rows whether or not they are soft-deleted.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { shouldRunRetentionCron } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { Cause, DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect'
import { invalidatePackageAppOwnerCacheForDbUserId } from '#app/package-app-owner.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { abortAccountDeleting } from '#worker/account/deletion-fence.ts'
import {
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccountEffect,
	toPromiseError,
} from '#app/account-deletion.ts'
import { AuditLog } from '#worker/effect/audit.ts'
import { startPassBudget } from '#worker/effect/budget.ts'
import { scopedClaim } from '#worker/effect/claim.ts'
import { D1, retryTransientD1, sql } from '#worker/effect/d1.ts'
import { ErrorReporter } from '#worker/effect/error-reporter.ts'
import { outbound } from '#worker/effect/outbound.ts'
import { runSlicePromise } from '#worker/effect/slice.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

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

const UnverifiedAccountRow = Schema.Struct({
	id: Schema.Number,
	stable_user_id: Schema.String,
	personal_org_id: Schema.NullOr(Schema.String),
	email: Schema.String,
	created_at: Schema.String,
})
type UnverifiedAccountRow = typeof UnverifiedAccountRow.Type

type UnverifiedAccountClaim = {
	readonly created: boolean
	readonly deletingAt: string
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
	if (Predicate.isObject(error)) {
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

const preCleanupFailures = new Set([
	'AccountDeletionInventoryError',
	'AccountDeletionBillingError',
	'AccountDeletionWritersActive',
])

function ageDays(createdAt: string, now: Date) {
	const createdMs = Date.parse(
		createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`,
	)
	if (!Number.isFinite(createdMs)) return unverifiedAccountPurgeDays
	return Math.floor((now.getTime() - createdMs) / millisecondsPerDay)
}

const passTime = (now: Date | undefined) =>
	now ? Effect.succeed(now) : Effect.map(DateTime.now, DateTime.toDateUtc)

/** Eligible accounts in claim order: unclaimed first, then oldest. */
const listUnverifiedAccountsPage = Effect.fn('UnverifiedAccountPurge.listPage')(
	function* (input: {
		readonly ageCutoff: string
		readonly retryBackoffCutoff: string
		readonly batchSize: number
	}) {
		const db = yield* D1
		const conditions = [
			...unverifiedPersonEligibilitySql,
			'datetime(created_at) < datetime(?)',
			'(deleting_at IS NULL OR datetime(deleting_at) < datetime(?))',
		].join('\n			AND ')
		return yield* retryTransientD1(
			db.all(
				'unverified_account_purge.page',
				UnverifiedAccountRow,
				sql(
					`SELECT id, stable_user_id, personal_org_id, email, created_at
					FROM users
					WHERE ${conditions}
					ORDER BY (deleting_at IS NULL) DESC, datetime(created_at) ASC, id ASC
					LIMIT ?`,
					input.ageCutoff,
					input.retryBackoffCutoff,
					input.batchSize,
				),
			),
		)
	},
)

/**
 * Claim an eligible account by stamping `deleting_at` (or restamping a fence
 * older than the backoff), then drop the package-app owner cache.
 */
const claimUnverifiedAccount = Effect.fn('UnverifiedAccountPurge.claim')(
	function* (input: {
		readonly dbUserId: number
		readonly now: Date
		readonly retryBackoffCutoff: string
	}) {
		const env = yield* WorkerEnv
		const db = yield* D1
		const deletingAt = utcSqliteTimestamp(input.now)
		const eligibility = unverifiedPersonEligibilitySql.join('\n					AND ')
		const invalidate = outbound('package_app_owner.invalidate', () =>
			invalidatePackageAppOwnerCacheForDbUserId(env.APP_DB, input.dbUserId),
		)
		const created = yield* retryTransientD1(
			db.run(
				'unverified_account_purge.claim',
				sql(
					`UPDATE users
					SET deleting_at = ?, updated_at = ?
					WHERE id = ?
						AND ${eligibility}
						AND deleting_at IS NULL`,
					deletingAt,
					deletingAt,
					input.dbUserId,
				),
			),
		)
		if (created.changes === 1) {
			yield* invalidate
			return Option.some<UnverifiedAccountClaim>({ created: true, deletingAt })
		}
		const restamped = yield* retryTransientD1(
			db.run(
				'unverified_account_purge.restamp',
				sql(
					`UPDATE users
					SET deleting_at = ?, updated_at = ?
					WHERE id = ?
						AND ${eligibility}
						AND datetime(deleting_at) < datetime(?)`,
					deletingAt,
					deletingAt,
					input.dbUserId,
					input.retryBackoffCutoff,
				),
			),
		)
		if (restamped.changes === 1) {
			yield* invalidate
			return Option.some<UnverifiedAccountClaim>({ created: false, deletingAt })
		}
		return Option.none<UnverifiedAccountClaim>()
	},
)

/**
 * The claim is released only when this pass created it and deletion stopped
 * before anything destructive ran. A failed release leaves the fence in
 * place; the retry backoff restamps it later, so it must not stop the batch.
 */
const settleClaim =
	(dbUserId: number, stableUserId: string) =>
	(claim: UnverifiedAccountClaim, exit: Exit.Exit<unknown, unknown>) => {
		const error = Option.getOrUndefined(Exit.findErrorOption(exit))
		const tag = Predicate.hasProperty(error, '_tag') ? String(error._tag) : null
		if (!claim.created || tag === null || !preCleanupFailures.has(tag)) {
			return Effect.logDebug('unverified account claim kept')
		}
		return abortAccountDeleting({
			dbUserId,
			expectedDeletingAt: claim.deletingAt,
		}).pipe(
			Effect.catch((releaseError) =>
				Effect.logWarning('unverified_account_purge_release_failed', {
					userId: stableUserId,
					error: releaseError,
				}),
			),
		)
	}

/**
 * Read-only preview of the next purge page: the accounts one run would try
 * to claim right now, in claim order. Performs no claims and no deletes.
 */
export const listUnverifiedAccountPurgeCandidatesEffect = Effect.fn(
	'UnverifiedAccountPurge.listCandidates',
)(function* (input: { readonly now?: Date; readonly batchSize?: number }) {
	const now = yield* passTime(input.now)
	const page = yield* listUnverifiedAccountsPage({
		...purgeCutoffs(now),
		batchSize: input.batchSize ?? unverifiedAccountPurgeBatchSize,
	})
	return {
		scanned: page.length,
		candidates: page.map(
			(account): UnverifiedAccountPurgeCandidate => ({
				stableUserId: account.stable_user_id as OwnerId,
				ageDays: ageDays(account.created_at, now),
			}),
		),
	}
})

/** Records a failed deletion: outcome, warn log, audit row, Sentry event. */
const recordFailure = Effect.fn('UnverifiedAccountPurge.recordFailure')(
	function* (account: UnverifiedAccountRow, accountAgeDays: number, failure: unknown) {
		const audit = yield* AuditLog
		const reporter = yield* ErrorReporter
		const warnings = deletionFailureWarnings(failure)
		const reason = unverifiedAccountPurgeFailureReason(failure, warnings)
		yield* Effect.logWarning('unverified_account_purge_failed', {
			userId: account.stable_user_id,
			warnings,
			error: reason,
		})
		// Workers Logs sampling drops most of the warn above; the audit row
		// and Sentry event are the best-effort durable record of why the
		// purge failed (each is skipped, not fatal, when its sink is down).
		yield* audit.record({
			category: 'account',
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email: account.email,
			reason,
		}).pipe(
			Effect.catchTag('OutboundCallError', (error) =>
				Effect.logWarning('unverified_account_purge_audit_failed', {
					userId: account.stable_user_id,
					error: error.cause,
				}),
			),
		)
		yield* reporter.capture(redactedErrorForReporting(failure), {
			requireDsn: true,
			tags: { 'scheduled.lane': 'unverified_account_purge' },
			// Stable id only: sendDefaultPii is false and emails stay out of Sentry.
			contexts: {
				unverified_account_purge: {
					userId: account.stable_user_id,
					warnings: [...warnings],
				},
			},
		})
		return {
			stableUserId: account.stable_user_id as OwnerId,
			ageDays: accountAgeDays,
			outcome: 'failed',
			error: reason,
			warnings: [...warnings],
		} satisfies UnverifiedAccountPurgeOutcome
	},
)

const processAccount = Effect.fn('UnverifiedAccountPurge.processAccount')(
	function* (
		account: UnverifiedAccountRow,
		now: Date,
		retryBackoffCutoff: string,
	) {
		const audit = yield* AuditLog
		const accountAgeDays = ageDays(account.created_at, now)
		const stableUserId = account.stable_user_id as OwnerId
		const deleted = yield* Effect.scoped(
			Effect.gen(function* () {
				const claim = yield* scopedClaim(
					claimUnverifiedAccount({
						dbUserId: account.id,
						now,
						retryBackoffCutoff,
					}),
					settleClaim(account.id, account.stable_user_id),
				)
				if (Option.isNone(claim)) return false
				yield* deleteUserAccountEffect({
					dbUserId: account.id,
					mcpUserId: personalOrgIdFromUserRow(account),
					personUserId: account.stable_user_id,
				})
				return true
			}),
		).pipe(
			Effect.map((purged) => ({ _tag: 'Done' as const, purged })),
			Effect.catchCause((cause) =>
				Effect.succeed({
					_tag: 'Failed' as const,
					failure: Cause.squash(Cause.map(cause, toPromiseError)),
				}),
			),
		)
		if (deleted._tag === 'Failed') {
			return yield* recordFailure(account, accountAgeDays, deleted.failure)
		}
		if (!deleted.purged) {
			return {
				stableUserId,
				ageDays: accountAgeDays,
				outcome: 'skipped_claim',
			} satisfies UnverifiedAccountPurgeOutcome
		}
		yield* audit.record({
			category: 'account',
			action: 'unverified_account_purged',
			result: 'success',
			email: account.email,
			reason: `unverified_for_${accountAgeDays}_days`,
		}).pipe(
			Effect.catchTag('OutboundCallError', (error) =>
				Effect.logWarning('unverified_account_purge_audit_failed', {
					userId: account.stable_user_id,
					error: error.cause,
				}),
			),
		)
		return {
			stableUserId,
			ageDays: accountAgeDays,
			outcome: 'purged',
		} satisfies UnverifiedAccountPurgeOutcome
	},
)

export const pruneUnverifiedAccountsEffect = Effect.fn(
	'UnverifiedAccountPurge.prune',
)(function* (input: {
	readonly now?: Date
	readonly timeBudgetMs?: number
	readonly batchSize?: number
}) {
	const now = yield* passTime(input.now)
	const budget = yield* startPassBudget(
		input.timeBudgetMs ?? unverifiedAccountPurgeRunTimeBudgetMs,
	)
	const { ageCutoff, retryBackoffCutoff } = purgeCutoffs(now)
	const page = yield* listUnverifiedAccountsPage({
		ageCutoff,
		retryBackoffCutoff,
		batchSize: input.batchSize ?? unverifiedAccountPurgeBatchSize,
	})
	const outcomes: Array<UnverifiedAccountPurgeOutcome> = []
	let timeBudgetExhausted = false
	for (const account of page) {
		if (yield* budget.reached) {
			timeBudgetExhausted = true
			break
		}
		outcomes.push(yield* processAccount(account, now, retryBackoffCutoff))
	}
	const result: UnverifiedAccountPurgeResult = {
		scanned: page.length,
		purged: outcomes.filter((outcome) => outcome.outcome === 'purged').length,
		failed: outcomes.filter((outcome) => outcome.outcome === 'failed').length,
		timeBudgetExhausted,
		outcomes,
	}
	yield* Effect.logInfo('unverified-account-purge', JSON.stringify(result))
	return result
})

export function listUnverifiedAccountPurgeCandidates(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<{
	scanned: number
	candidates: Array<UnverifiedAccountPurgeCandidate>
}> {
	const { env, ...rest } = input
	return runSlicePromise(env, listUnverifiedAccountPurgeCandidatesEffect(rest))
}

export function pruneUnverifiedAccounts(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
}): Promise<UnverifiedAccountPurgeResult> {
	const { env, ...rest } = input
	return runSlicePromise(env, pruneUnverifiedAccountsEffect(rest))
}
