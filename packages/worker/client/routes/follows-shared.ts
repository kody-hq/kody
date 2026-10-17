import {
	followCreateLimitPerHour,
	followEventCopy,
	followPauseReasonCopy,
	followPausedRetentionDays,
	normalizeFollowEvents,
	type FollowEvent,
	type FollowSummary,
	type FollowOperationResult,
	type PackageFollowStatePayload,
} from '#universal/follows.ts'

export const followDeliveryNote = `Deliveries are free. Handlers that run on them use this workspace’s credits. A workspace can start following up to ${followCreateLimitPerHour} new things an hour.`

export const followPausedRetentionNote = `Paused follows are deleted after ${followPausedRetentionDays} days.`

/** "New versions and pushes", for a status line. */
export function describeFollowEvents(events: ReadonlyArray<FollowEvent>) {
	const labels = normalizeFollowEvents(events).map((event) =>
		followEventCopy[event].label.toLowerCase(),
	)
	if (labels.length === 0) return 'nothing'
	const sentence = labels.join(' and ')
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
}

/** Why a paused follow stopped, as one sentence the page can show as-is. */
export function describePausedFollow(
	follow: Pick<FollowSummary, 'status' | 'pausedReason'>,
) {
	if (follow.status !== 'paused') return null
	return `Paused. ${followPauseReasonCopy(follow.pausedReason)}`
}

/**
 * Events the panel offers to toggle and why one is off. Pushes need read
 * access; a run-only grant can see the package but not its source.
 */
export function followEventOptions(
	state: Pick<
		PackageFollowStatePayload,
		'availableEvents' | 'canPush' | 'target'
	>,
) {
	return state.availableEvents.map((event) => ({
		event,
		...followEventCopy[event],
		disabledReason:
			event === 'pushed' && !state.canPush
				? `Pushes need read access to ${state.target.name}. A Use grant includes read; run-only access does not.`
				: null,
	}))
}

type FollowEventAccess = Pick<
	PackageFollowStatePayload,
	'availableEvents' | 'canPush'
>

function offerableFollowEvents(state: FollowEventAccess) {
	return state.availableEvents.filter(
		(event) => event !== 'pushed' || state.canPush,
	)
}

/** Events checked when the panel opens for one workspace. */
export function initialFollowEventChoice(
	state: FollowEventAccess,
	follow: FollowSummary | null,
): Array<FollowEvent> {
	if (follow) return normalizeFollowEvents(follow.events)
	return offerableFollowEvents(state)
}

/**
 * What Save or Resume sends. An untouched existing choice sends nothing so
 * the server keeps it, including events the viewer can no longer turn on; an
 * edited choice can only carry events the viewer can turn on now.
 */
export function followEventsToSubmit(
	state: FollowEventAccess,
	follow: Pick<FollowSummary, 'events'> | null,
	chosen: ReadonlyArray<FollowEvent>,
): { events: Array<FollowEvent> | undefined; dropsGated: boolean } {
	const picked = normalizeFollowEvents(chosen)
	if (follow && normalizeFollowEvents(follow.events).join() === picked.join()) {
		return { events: undefined, dropsGated: false }
	}
	const offerable = offerableFollowEvents(state)
	return {
		events: picked.filter((event) => offerable.includes(event)),
		dropsGated: Boolean(
			follow?.events.some((event) => !offerable.includes(event)),
		),
	}
}

/** Copy for a failed follow change. Rate limits name the workspace's hourly cap. */
export function followErrorMessage(
	payload: Extract<FollowOperationResult, { ok: false }>,
) {
	switch (payload.code) {
		case 'rate_limited':
			return `This workspace has started following ${followCreateLimitPerHour} things in the last hour, which is the limit. Try again in about an hour. Changing events or unfollowing still works.`
		case 'invalid':
		case 'not_found':
		case 'unauthorized':
			return payload.error
		default: {
			const exhaustive: never = payload.code
			throw new Error(`Unhandled follow error code: ${String(exhaustive)}`)
		}
	}
}
