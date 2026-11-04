import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	type ExternalReconcileCursor,
	type ExternalReconcileSourceRow,
	listEntitySourcesForExternalReconcile,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { revokeStaleArtifactsTokens } from '#worker/repo/artifacts-tokens.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { getSavedPackageLockedAt } from '#worker/package-registry/repo.ts'
import { isSavedPackageLocked } from '#worker/package-registry/package-publish-lock.ts'
import { getPendingPackageApprovalRequest } from '#worker/package-capabilities/approval-requests-repo.ts'

export type ReconcileArtifactsPushesResult = {
	checked: number
	published: number
	alreadyPublished: number
	missingHead: number
	checksFailed: number
	notFastForward: number
	lockedSkipped: number
	approvalRequiredSkipped: number
	failedHeadSkipped: number
	errors: number
	sourceTimeouts: number
	tokenCleanupErrors: number
	tokensRevoked: number
	batches: number
	budgetExhausted: boolean
}

const defaultBatchSize = 50
const defaultStaleAfterMinutes = 5
/**
 * Wall-clock budget for one cron tick. The reconcile loop keeps pulling
 * batches of stale sources until it either drains the backlog or exceeds
 * this budget, so throughput scales with available time instead of being
 * capped at one batch per five-minute tick.
 */
export const reconcileTimeBudgetMs = 60_000
/**
 * Most one source may hold a tick. Without it a single clone + checks publish
 * kept ticks running to the 15-minute consumer limit, and overlapping ticks
 * stacked up in one isolate. The abandoned publish finishes on its own; the
 * source is re-selected by a later tick.
 */
export const reconcileSourceTimeoutMs = 45_000
/** How long a HEAD whose checks failed is skipped before checks run again. */
export const failedHeadRetryWindowMinutes = 6 * 60

type SourceOutcome =
	| 'missingHead'
	| 'lockedSkipped'
	| 'alreadyPublished'
	| 'approvalRequiredSkipped'
	| 'failedHeadSkipped'
	| 'published'
	| 'checksFailed'
	| 'notFastForward'

class ReconcileSourceTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Reconcile source exceeded its ${timeoutMs}ms deadline.`)
		this.name = 'ReconcileSourceTimeoutError'
	}
}

async function withSourceDeadline<T>(
	work: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	// The abandoned work may still reject after the deadline wins.
	work.catch(() => {})
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new ReconcileSourceTimeoutError(timeoutMs)),
					timeoutMs,
				)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

function minutesAgoIso(now: Date, minutes: number) {
	return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function shouldRunDailyTokenCleanup(now: Date) {
	return now.getUTCHours() === 3 && now.getUTCMinutes() < 5
}

export async function reconcileArtifactsPushes(input: {
	env: Env
	baseUrl: string
	batchSize?: number
	staleAfterMinutes?: number
	timeBudgetMs?: number
	sourceTimeoutMs?: number
	now?: Date
}): Promise<ReconcileArtifactsPushesResult> {
	const now = input.now ?? new Date()
	const batchSize = input.batchSize ?? defaultBatchSize
	const before = minutesAgoIso(
		now,
		input.staleAfterMinutes ?? defaultStaleAfterMinutes,
	)
	const deadlineMs = Date.now() + (input.timeBudgetMs ?? reconcileTimeBudgetMs)
	const result: ReconcileArtifactsPushesResult = {
		checked: 0,
		published: 0,
		alreadyPublished: 0,
		missingHead: 0,
		checksFailed: 0,
		notFastForward: 0,
		lockedSkipped: 0,
		approvalRequiredSkipped: 0,
		failedHeadSkipped: 0,
		errors: 0,
		sourceTimeouts: 0,
		tokenCleanupErrors: 0,
		tokensRevoked: 0,
		batches: 0,
		budgetExhausted: false,
	}
	const shouldCleanupTokens = shouldRunDailyTokenCleanup(now)
	const includeAllSources = shouldCleanupTokens
	// Sources whose cursor write failed stay stale and would be re-selected by
	// the next batch query; tracking seen ids prevents re-processing them in a
	// tight loop within a single tick.
	const seenSourceIds = new Set<string>()
	let after: ExternalReconcileCursor | undefined
	while (!result.budgetExhausted) {
		const batch = await listEntitySourcesForExternalReconcile(
			input.env.APP_DB,
			{
				before,
				limit: batchSize,
				after,
				...(includeAllSources ? { includeAll: true } : {}),
			},
		)
		const lastRow = batch.at(-1)
		if (lastRow) {
			// Advance the keyset past every fetched row so a head row whose
			// `last_external_check_at` write keeps failing cannot pin the front
			// of the stale ordering and starve the sources behind it.
			after = {
				staleOrderedAt: lastRow.last_external_check_at ?? lastRow.created_at,
				id: lastRow.id,
			}
		}
		const sources = batch.filter((source) => !seenSourceIds.has(source.id))
		if (sources.length === 0) break
		result.batches += 1
		for (const source of sources) {
			seenSourceIds.add(source.id)
			await reconcileSource({
				env: input.env,
				baseUrl: input.baseUrl,
				source,
				now,
				shouldCleanupTokens,
				sourceTimeoutMs: input.sourceTimeoutMs ?? reconcileSourceTimeoutMs,
				result,
			})
			if (Date.now() >= deadlineMs) {
				result.budgetExhausted = true
				break
			}
		}
		if (batch.length < batchSize) break
	}
	console.info('reconcile_artifacts_pushes', result)
	return result
}

async function reconcileSource(input: {
	env: Env
	baseUrl: string
	source: ExternalReconcileSourceRow
	now: Date
	shouldCleanupTokens: boolean
	sourceTimeoutMs: number
	result: ReconcileArtifactsPushesResult
}) {
	const { env, source, now, result } = input
	if (source.entity_kind === 'repo') {
		return
	}
	result.checked += 1
	try {
		const outcome = await withSourceDeadline(
			checkSource(input),
			input.sourceTimeoutMs,
		)
		result[outcome] += 1
	} catch (error) {
		if (error instanceof ReconcileSourceTimeoutError) {
			result.sourceTimeouts += 1
		} else {
			result.errors += 1
		}
		console.warn('reconcile_artifacts_pushes source failed', {
			sourceId: source.id,
			repoId: source.repo_id,
			error: getErrorMessage(error),
		})
		try {
			await updateEntitySource(env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
			})
		} catch (updateError) {
			console.warn('reconcile_artifacts_pushes cursor update failed', {
				sourceId: source.id,
				repoId: source.repo_id,
				error: getErrorMessage(updateError),
			})
		}
	}
}

async function checkSource(input: {
	env: Env
	baseUrl: string
	source: ExternalReconcileSourceRow
	now: Date
	shouldCleanupTokens: boolean
	result: ReconcileArtifactsPushesResult
}): Promise<SourceOutcome> {
	const { env, source, now, result } = input
	const advanceCursor = () =>
		updateEntitySource(env.APP_DB, {
			id: source.id,
			userId: source.user_id,
			lastExternalCheckAt: now.toISOString(),
		})
	const head = await resolveArtifactSourceHead(env, source.repo_id)
	if (input.shouldCleanupTokens) {
		try {
			const cleanup = await revokeStaleArtifactsTokens(env, source.repo_id, {
				keepAfter: now,
			})
			result.tokensRevoked += cleanup.revoked
		} catch (cleanupError) {
			result.tokenCleanupErrors += 1
			console.warn('reconcile_artifacts_pushes token cleanup failed', {
				sourceId: source.id,
				repoId: source.repo_id,
				error: getErrorMessage(cleanupError),
			})
		}
	}
	// Unchanged (or unresolvable) HEADs only advance the reconcile cursor;
	// the RepoSession Durable Object is spun up solely for changed HEADs.
	if (!head.commit) {
		await advanceCursor()
		return 'missingHead'
	}
	if (
		source.entity_kind === 'package' &&
		isSavedPackageLocked(
			await getSavedPackageLockedAt(env.APP_DB, {
				userId: source.user_id,
				packageId: source.entity_id,
			}),
		)
	) {
		await advanceCursor()
		return 'lockedSkipped'
	}
	if (head.commit === source.published_commit) {
		const horizonPassed =
			source.external_check_until !== null &&
			source.external_check_until <= now.toISOString()
		await updateEntitySource(env.APP_DB, {
			id: source.id,
			userId: source.user_id,
			lastExternalCheckAt: now.toISOString(),
			...(horizonPassed ? { externalCheckUntil: null } : {}),
		})
		return 'alreadyPublished'
	}
	const pendingApproval =
		source.entity_kind === 'package'
			? await getPendingPackageApprovalRequest(env.APP_DB, {
					packageId: source.entity_id,
					ownerUserId: source.user_id,
					reason: 'credential_needs_changed',
				})
			: null
	// A request against an older published commit is stale; re-running the
	// gate supersedes it.
	if (
		pendingApproval?.pendingCommit === head.commit &&
		pendingApproval.baseCommit === source.published_commit
	) {
		await advanceCursor()
		return 'approvalRequiredSkipped'
	}
	if (
		source.external_check_failed_commit === head.commit &&
		source.external_check_failed_at !== null &&
		source.external_check_failed_at >
			minutesAgoIso(now, failedHeadRetryWindowMinutes)
	) {
		console.info('reconcile_artifacts_pushes failed head skipped', {
			sourceId: source.id,
			commit: head.commit,
			failedAt: source.external_check_failed_at,
		})
		await advanceCursor()
		return 'failedHeadSkipped'
	}
	const sessionId = `external-reconcile-${source.id}`
	const publishResult = await repoSessionRpc(
		env,
		sessionId,
	).publishFromExternalRef({
		sessionId,
		sourceId: source.id,
		userId: source.user_id,
		newCommit: head.commit,
		expectedHead: head.commit,
		allowForce: false,
		baseUrl: input.baseUrl,
	})
	const outcome = publishOutcome(publishResult.status)
	const settled = outcome === 'published' || outcome === 'alreadyPublished'
	await updateEntitySource(env.APP_DB, {
		id: source.id,
		userId: source.user_id,
		lastExternalCheckAt: now.toISOString(),
		...(settled
			? {
					externalCheckUntil: null,
					externalCheckFailedCommit: null,
					externalCheckFailedAt: null,
				}
			: {}),
		...(outcome === 'checksFailed'
			? {
					externalCheckFailedCommit: head.commit,
					externalCheckFailedAt: now.toISOString(),
				}
			: {}),
	})
	return outcome
}

function publishOutcome(
	status: Awaited<
		ReturnType<ReturnType<typeof repoSessionRpc>['publishFromExternalRef']>
	>['status'],
): SourceOutcome {
	switch (status) {
		case 'already_published':
			return 'alreadyPublished'
		case 'published':
			return 'published'
		case 'checks_failed':
			return 'checksFailed'
		case 'not_fast_forward':
			return 'notFastForward'
		case 'locked':
			return 'lockedSkipped'
		case 'approval_required':
			return 'approvalRequiredSkipped'
		default: {
			const exhaustive: never = status
			throw new Error(`Unknown external publish status: ${String(exhaustive)}`)
		}
	}
}
