import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	type ExternalReconcileCursor,
	listEntitySourcesForExternalReconcile,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
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
	errors: number
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
		errors: 0,
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
	source: EntitySourceRow
	now: Date
	shouldCleanupTokens: boolean
	result: ReconcileArtifactsPushesResult
}) {
	const { env, source, now, result } = input
	if (source.entity_kind === 'repo') {
		return
	}
	result.checked += 1
	try {
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
			result.missingHead += 1
			await updateEntitySource(env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
			})
			return
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
			result.lockedSkipped += 1
			await updateEntitySource(env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
			})
			return
		}
		if (head.commit === source.published_commit) {
			result.alreadyPublished += 1
			const horizonPassed =
				source.external_check_until !== null &&
				source.external_check_until <= now.toISOString()
			await updateEntitySource(env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
				...(horizonPassed ? { externalCheckUntil: null } : {}),
			})
			return
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
			result.approvalRequiredSkipped += 1
			await updateEntitySource(env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				lastExternalCheckAt: now.toISOString(),
			})
			return
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
		switch (publishResult.status) {
			case 'already_published':
				result.alreadyPublished += 1
				break
			case 'published':
				result.published += 1
				break
			case 'checks_failed':
				result.checksFailed += 1
				break
			case 'not_fast_forward':
				result.notFastForward += 1
				break
			case 'locked':
				result.lockedSkipped += 1
				break
			case 'approval_required':
				result.approvalRequiredSkipped += 1
				break
			default: {
				const exhaustive: never = publishResult
				throw new Error(
					`Unknown external publish status: ${String(exhaustive)}`,
				)
			}
		}
		await updateEntitySource(env.APP_DB, {
			id: source.id,
			userId: source.user_id,
			lastExternalCheckAt: now.toISOString(),
			...(publishResult.status === 'published' ||
			publishResult.status === 'already_published'
				? { externalCheckUntil: null }
				: {}),
		})
	} catch (error) {
		result.errors += 1
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
