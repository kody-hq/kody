import type { CommunityActivityRecord } from './types.ts'

export const communityActivityRecordedTopic = 'community.activity.recorded'

type CommunityActivityEventBase = {
	id: string
	listing: {
		id: string
		name: string
		kody_id: string
	}
	actor: {
		username: string | null
	}
	occurred_at: string
}

export type CommunityActivityRecordedEvent = {
	event: typeof communityActivityRecordedTopic
	event_id: string
	activity:
		| (CommunityActivityEventBase & { kind: 'fork' })
		| (CommunityActivityEventBase & {
				kind: 'rating'
				stars: number
				adaptation_effort: number
		  })
}

export function buildCommunityActivityRecordedEvent(input: {
	eventId: string
	activity: CommunityActivityRecord
}): CommunityActivityRecordedEvent {
	const shared = {
		id: input.activity.id,
		listing: {
			id: input.activity.listingId,
			name: input.activity.listingName,
			kody_id: input.activity.listingKodyId,
		},
		actor: {
			username: input.activity.actingUsername,
		},
		occurred_at: input.activity.occurredAt,
	}
	switch (input.activity.kind) {
		case 'fork':
			return {
				event: communityActivityRecordedTopic,
				event_id: input.eventId,
				activity: { ...shared, kind: input.activity.kind },
			}
		case 'rating':
			return {
				event: communityActivityRecordedTopic,
				event_id: input.eventId,
				activity: {
					...shared,
					kind: input.activity.kind,
					stars: input.activity.stars,
					adaptation_effort: input.activity.adaptationEffort,
				},
			}
		default: {
			const exhaustive: never = input.activity
			throw new Error(`Unsupported community activity: ${String(exhaustive)}`)
		}
	}
}
