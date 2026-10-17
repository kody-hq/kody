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
	}>
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
