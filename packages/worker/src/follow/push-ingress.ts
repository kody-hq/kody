import type { CloudflareArtifactsRepoEvent } from '#worker/repo/artifacts-events.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { mergeFollowPushWindow, type FollowPushIngress } from './coalesce.ts'
import { deliverFollowRecords } from './deliver.ts'
import {
	getFollowPushPending,
	hasAppDb,
	listActiveFollowsByTarget,
	upsertFollowPushPending,
} from './repo.ts'
import type { FollowPushCommit, FollowTargetKind } from './types.ts'

const followPushCoalesceAttempts = 5

/**
 * Record a default-branch push into the target's five-minute window.
 * No follows means no row. An expired window is flushed before the new
 * push replaces it; if that flush fails the new commits stay on the old
 * row so the maintenance lane can retry. A compare-and-swap miss re-reads
 * and merges so a concurrent push is not overwritten.
 */
export async function recordFollowDefaultBranchPush(input: {
	env: Env
	source: EntitySourceRow
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.pushed' }
	>
	/** Wall clock for window open/close. Tests may pin this. */
	now?: Date
}): Promise<void> {
	if (!hasAppDb(input.env.APP_DB)) return
	const targetKind = followTargetKindForEntity(input.source.entity_kind)
	if (!targetKind) return
	const follows = await listActiveFollowsByTarget(input.env.APP_DB, {
		targetKind,
		targetId: input.source.entity_id,
	})
	if (follows.length === 0) return
	const incoming = ingressFromEvent(input.event)
	const now = input.now ?? new Date()
	for (let attempt = 0; attempt < followPushCoalesceAttempts; attempt += 1) {
		const wrote = await coalesceOneFollowPush({
			env: input.env,
			targetKind,
			targetId: input.source.entity_id,
			incoming,
			now,
		})
		if (wrote) return
	}
	console.error('follow-push-coalesce-contended', input.source.entity_id)
}

async function coalesceOneFollowPush(input: {
	env: Env
	targetKind: FollowTargetKind
	targetId: string
	incoming: ReturnType<typeof ingressFromEvent>
	now: Date
}): Promise<boolean> {
	const existing = await getFollowPushPending(input.env.APP_DB, {
		targetKind: input.targetKind,
		targetId: input.targetId,
	})
	const merged = mergeFollowPushWindow({
		targetKind: input.targetKind,
		targetId: input.targetId,
		existing,
		incoming: input.incoming,
		// Wall clock: delayed webhooks must not reopen a flushed window.
		now: input.now,
	})
	const expected = existing
		? { revision: existing.revision, generation: existing.generation }
		: null
	switch (merged.action) {
		case 'unchanged':
			return true
		case 'merge':
			return await upsertFollowPushPending(
				input.env.APP_DB,
				merged.pending,
				expected,
			)
		case 'replace': {
			const flushed = await flushPendingWindow({
				env: input.env,
				pending: merged.expired,
			})
			if (!flushed) {
				const kept = mergeFollowPushWindow({
					targetKind: input.targetKind,
					targetId: input.targetId,
					existing: merged.expired,
					incoming: input.incoming,
					now: new Date(merged.expired.windowStartedAt),
				})
				return await upsertFollowPushPending(
					input.env.APP_DB,
					kept.pending,
					expected,
				)
			}
			return await upsertFollowPushPending(
				input.env.APP_DB,
				merged.pending,
				expected,
			)
		}
		default: {
			const exhaustive: never = merged
			throw new Error(`Unhandled follow push merge: ${String(exhaustive)}`)
		}
	}
}

export async function flushPendingWindow(input: {
	env: Env
	pending: {
		targetKind: FollowTargetKind
		targetId: string
		windowStartedAt: string
		beforeCommit: string | null
		afterCommit: string | null
		ref: string
		commits: Array<FollowPushCommit>
		totalCommitsCount: number
		updatedAt: string
		revision: number
		generation: string
	}
}): Promise<boolean> {
	try {
		const follows = await listActiveFollowsByTarget(input.env.APP_DB, {
			targetKind: input.pending.targetKind,
			targetId: input.pending.targetId,
		})
		await deliverFollowRecords({
			env: input.env,
			follows,
			now: new Date(),
			pushed: input.pending,
		})
		return true
	} catch (error) {
		console.error('follow-push-flush-failed', input.pending.targetId, error)
		return false
	}
}

function followTargetKindForEntity(
	kind: EntitySourceRow['entity_kind'],
): FollowTargetKind | null {
	switch (kind) {
		case 'package':
		case 'repo':
			return kind
		default: {
			const exhaustive: never = kind
			throw new Error(`Unsupported entity kind: ${exhaustive}`)
		}
	}
}

function ingressFromEvent(
	event: Extract<
		CloudflareArtifactsRepoEvent,
		{ type: 'cf.artifacts.repo.pushed' }
	>,
): FollowPushIngress {
	return {
		before: event.payload.before,
		after: event.payload.after,
		ref: event.payload.ref,
		totalCommitsCount: event.payload.totalCommitsCount,
		at: event.metadata.eventTimestamp,
		commits: event.payload.commits.map((commit) => ({
			id: commit.id,
			message: commit.message,
			message_truncated: commit.messageTruncated,
			timestamp: commit.timestamp,
			author: commit.author,
			committer: commit.committer,
			parents: commit.parents,
		})),
	}
}
