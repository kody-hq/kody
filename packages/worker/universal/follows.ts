/**
 * Follow vocabulary shared by the worker (follow records, delivery) and the
 * web UI (Follow control, Follows page). Topics are `follow.published` and
 * `follow.pushed`; the follower picks which of the two a follow delivers.
 */

export const followEvents = ['published', 'pushed'] as const

export type FollowEvent = (typeof followEvents)[number]

export const followPauseReasons = ['target_missing', 'access_lost'] as const

export type FollowPauseReason = (typeof followPauseReasons)[number]

export const followCreateLimitPerHour = 30
export const followPausedRetentionDays = 30
/** Recent updates kept per follow; older ones drop on insert. */
export const followRecentUpdatesPerFollow = 20
export const followRecentUpdatesRetentionDays = 30

export function isFollowPauseReason(
	value: unknown,
): value is FollowPauseReason {
	return value === 'target_missing' || value === 'access_lost'
}

/** Dedupes and orders events the way the UI lists them. */
export function normalizeFollowEvents(
	events: ReadonlyArray<FollowEvent>,
): Array<FollowEvent> {
	return followEvents.filter((event) => events.includes(event))
}

/**
 * Events a follow of this kind can ever deliver. Plain repos are never
 * published, so they only offer pushes.
 */
export function followEventsForKind(
	kind: 'package' | 'repo',
): Array<FollowEvent> {
	switch (kind) {
		case 'package':
			return ['published', 'pushed']
		case 'repo':
			return ['pushed']
		default: {
			const exhaustive: never = kind
			throw new Error(`Unsupported follow target kind: ${String(exhaustive)}`)
		}
	}
}

export const followEventCopy: Record<
	FollowEvent,
	{ label: string; description: string; topic: string }
> = {
	published: {
		label: 'New versions',
		description: 'When a new version is published.',
		topic: 'follow.published',
	},
	pushed: {
		label: 'Pushes',
		description: 'When the default branch gets new commits.',
		topic: 'follow.pushed',
	},
}

export function followPauseReasonCopy(reason: FollowPauseReason | null) {
	switch (reason) {
		case 'target_missing':
			return 'It was deleted or moved somewhere you can’t see.'
		case 'access_lost':
			return 'Whoever followed it no longer has read access.'
		case null:
			return 'You no longer have access to it, or it was removed.'
		default: {
			const exhaustive: never = reason
			throw new Error(`Unsupported pause reason: ${String(exhaustive)}`)
		}
	}
}

export function followSkipReasonCopy(reason: string | null) {
	if (!reason) return null
	if (reason === 'zero_credits') {
		return 'The last delivery was skipped because this workspace was out of credits.'
	}
	return 'The last delivery was skipped.'
}

/** When a paused follow is deleted, or null for an active follow. */
export function followPausedDeleteAt(pausedAt: string | null) {
	if (!pausedAt) return null
	const time = Date.parse(pausedAt)
	if (Number.isNaN(time)) return null
	return new Date(
		time + followPausedRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
}

export type FollowTargetKindName = 'package' | 'repo'

type FollowStatusName = 'active' | 'paused'

/** One org's follow of one target, as the web UI shows it. */
export type FollowSummary = {
	status: FollowStatusName
	events: Array<FollowEvent>
	pausedAt: string | null
	pausedReason: FollowPauseReason | null
	lastDeliverySkipReason: string | null
}

/** Authorized target and workspace choices returned by loadPackageFollow. */
export type PackageFollowStatePayload = {
	ok: true
	target: { name: string; kind: FollowTargetKindName }
	/** Events this target can send. Plain repos only send pushes. */
	availableEvents: Array<FollowEvent>
	/** The viewer may receive pushes (needs read access, not run-only). */
	canPush: boolean
	/** Workspaces the viewer is a member of, each with its follow (if any). */
	workspaces: Array<{
		slug: string
		displayName: string | null
		personal: boolean
		follow: FollowSummary | null
		/** Follow events no enabled package subscription in this workspace handles. */
		unhandledEvents: Array<FollowEvent>
		/** This follow's latest Recent updates, newest first. */
		recentUpdates: Array<FollowRecentUpdate>
	}>
}

/** What an unhandled delivery carried, enough to describe it later. */
export type FollowRecentUpdateDetail =
	| {
			event: 'published'
			publishedCommit: string
			previousCommit: string | null
	  }
	| {
			event: 'pushed'
			ref: string
			afterCommit: string | null
			totalCommits: number
			latestMessage: string | null
	  }

/** One Recent updates entry: a follow event no package handled. */
export type FollowRecentUpdate = {
	id: string
	name: string
	kind: FollowTargetKindName
	/** The target's page, or null when the stored name no longer parses. */
	href: string | null
	event: FollowEvent
	occurredAt: string
	summary: string
}

function shortCommit(commit: string | null) {
	return commit ? commit.slice(0, 7) : null
}

/** "Published version abc1234" or "3 commits pushed to main: Fix typo". */
export function describeFollowRecentUpdate(detail: FollowRecentUpdateDetail) {
	switch (detail.event) {
		case 'published':
			return `Published version ${shortCommit(detail.publishedCommit)}`
		case 'pushed': {
			const branch = detail.ref.replace(/^refs\/heads\//, '')
			const count = `${detail.totalCommits} ${detail.totalCommits === 1 ? 'commit' : 'commits'}`
			const message = detail.latestMessage?.split('\n')[0]?.trim()
			return `${count} pushed to ${branch}${message ? `: ${message}` : ''}`
		}
		default: {
			const exhaustive: never = detail
			throw new Error(`Unsupported recent update: ${String(exhaustive)}`)
		}
	}
}

/**
 * Selected events that no enabled package subscription in the org handles,
 * so they land in Recent updates. Empty while paused.
 */
export function followUnhandledEvents(
	follow: Pick<FollowSummary, 'status' | 'events'>,
	unhandledEvents: ReadonlyArray<FollowEvent>,
) {
	if (follow.status !== 'active') return []
	return normalizeFollowEvents(
		follow.events.filter((event) => unhandledEvents.includes(event)),
	)
}

export type OrgFollowRow = FollowSummary & {
	/** Opaque follow id. The UI only shows it inside a Details disclosure. */
	id: string
	name: string
	kind: FollowTargetKindName
	/** The target's page, or null when the stored name no longer parses. */
	href: string | null
	availableEvents: Array<FollowEvent>
	createdAt: string
	/** Paused follows are deleted on this date. Null while active. */
	deleteAt: string | null
	lastDeliverySkipAt: string | null
}

export type OrgFollowsLoaderData = {
	ok: true
	orgSlug: string
	follows: Array<OrgFollowRow>
	/** Follow events no enabled package subscription in this org handles. */
	unhandledEvents: Array<FollowEvent>
	/** Newest first, across every follow in the org. */
	recentUpdates: Array<FollowRecentUpdate>
}

type FollowOperationErrorCode =
	| 'invalid'
	| 'not_found'
	| 'rate_limited'
	| 'unauthorized'

export type FollowOperationResult =
	| {
			ok: true
			name: string
			kind: FollowTargetKindName
			follow: FollowSummary | null
	  }
	| { ok: false; code: FollowOperationErrorCode; error: string }
