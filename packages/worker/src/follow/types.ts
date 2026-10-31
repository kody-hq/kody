import {
	followCreateLimitPerHour,
	followEventsForKind,
	followPausedRetentionDays,
	followRecentUpdatesRetentionDays,
	type FollowEvent,
	type FollowPauseReason,
	type FollowRecentUpdateDetail,
} from '#universal/follows.ts'

export {
	followEvents,
	followPauseReasons,
	type FollowEvent,
	type FollowPauseReason,
} from '#universal/follows.ts'

export const followTargetKinds = ['package', 'repo'] as const

export type FollowTargetKind = (typeof followTargetKinds)[number]

export const followStatuses = ['active', 'paused'] as const

export type FollowStatus = (typeof followStatuses)[number]

export const followPublishedTopic = 'follow.published'
export const followPushedTopic = 'follow.pushed'

export const followCreateMaxPerHour = followCreateLimitPerHour
export const followCreateWindowSeconds = 60 * 60
export const followPushWindowMs = 5 * 60 * 1000
export const followPushMaxCommits = 20
export const followPauseRetentionMs =
	followPausedRetentionDays * 24 * 60 * 60 * 1000
export const followZeroCreditsSkipReason = 'zero_credits'
export const followRecentUpdatesRetentionMs =
	followRecentUpdatesRetentionDays * 24 * 60 * 60 * 1000

/** A stored Recent updates row joined to its follow's target. */
export type FollowRecentUpdateRecord = {
	id: string
	followId: string
	targetName: string
	targetKind: FollowTargetKind
	detail: FollowRecentUpdateDetail
	occurredAt: string
}

export type FollowPushCommit = {
	id: string
	message: string
	message_truncated: boolean
	timestamp: string
	author: { name: string; email: string }
	committer: { name: string; email: string }
	parents: Array<string>
}

export type FollowRecord = {
	id: string
	followerOrgId: string
	creatorUserId: string
	/** Profile (ADR 0092) whose access gates delivery; null is the person. */
	creatorProfileId: string | null
	targetKind: FollowTargetKind
	targetOwnerId: string
	targetId: string
	targetName: string
	status: FollowStatus
	pausedAt: string | null
	pausedReason: FollowPauseReason | null
	publishedEnabled: boolean
	pushedEnabled: boolean
	lastDeliverySkipReason: string | null
	lastDeliverySkipAt: string | null
	createdAt: string
	updatedAt: string
}

export type FollowView = {
	name: string
	kind: FollowTargetKind
	status: FollowStatus
	/** Events this follow delivers: `published` and/or `pushed`. */
	events: Array<FollowEvent>
	created_at: string
	paused_at: string | null
	paused_reason: FollowPauseReason | null
	last_delivery_skip_reason: string | null
}

export type FollowPushPending = {
	targetKind: FollowTargetKind
	targetId: string
	windowStartedAt: string
	beforeCommit: string | null
	afterCommit: string | null
	ref: string
	commits: Array<FollowPushCommit>
	totalCommitsCount: number
	/** Webhook event time for tip ordering; not the CAS token. */
	updatedAt: string
	/** Monotonic DB write counter used for compare-and-swap. */
	revision: number
	/**
	 * Per-insert identity paired with `revision` for compare-and-swap, so a
	 * row deleted and reinserted (revision back at 0) never matches an older
	 * snapshot. Rows that predate it read as ''.
	 */
	generation: string
}

export type FollowTargetSnapshot = {
	kind: FollowTargetKind
	ownerId: string
	id: string
	name: string
	isPrivate: boolean
}

/** Chosen events this kind can deliver (plain repos are never published). */
export function followRecordEvents(
	record: Pick<
		FollowRecord,
		'targetKind' | 'publishedEnabled' | 'pushedEnabled'
	>,
): Array<FollowEvent> {
	return followEventsForKind(record.targetKind).filter((event) =>
		event === 'published' ? record.publishedEnabled : record.pushedEnabled,
	)
}

export function followView(record: FollowRecord): FollowView {
	return {
		name: record.targetName,
		kind: record.targetKind,
		status: record.status,
		events: followRecordEvents(record),
		created_at: record.createdAt,
		paused_at: record.pausedAt,
		paused_reason: record.pausedReason,
		last_delivery_skip_reason: record.lastDeliverySkipReason,
	}
}

export function isFollowTargetKind(value: string): value is FollowTargetKind {
	switch (value) {
		case 'package':
		case 'repo':
			return true
		default:
			return false
	}
}
