import {
	emptyFirstTouchAttribution,
	firstTouchAttributionToUserColumns,
	hasFirstTouchAttribution,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'

export const userCreatedTopic = 'user.created'
export const userDeletedTopic = 'user.deleted'

export const userLifecycleEventTopics = [
	userCreatedTopic,
	userDeletedTopic,
] as const

export type UserCreatedTopic = typeof userCreatedTopic
export type UserDeletedTopic = typeof userDeletedTopic
export type UserLifecycleEventTopic = (typeof userLifecycleEventTopics)[number]

export const userCreatedSources = ['signup', 'oauth', 'admin'] as const
export type UserCreatedSource = (typeof userCreatedSources)[number]

export type UserLifecycleIdentity = {
	id: string
	username: string
	email: string
}

export type UserCreatedAttribution = {
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	landing_path: string | null
	referrer: string | null
}

export type UserCreatedEvent = {
	event: UserCreatedTopic
	user: UserLifecycleIdentity
	source: UserCreatedSource
	created_at: string
	attribution: UserCreatedAttribution
}

export type UserDeletedEvent = {
	event: UserDeletedTopic
	user: UserLifecycleIdentity
	/** Account signup time (ISO 8601), read before or at deletion. */
	created_at: string
	deleted_at: string
}

export type UserLifecycleEvent = UserCreatedEvent | UserDeletedEvent

export function isUserLifecycleEventTopic(
	value: string,
): value is UserLifecycleEventTopic {
	return (userLifecycleEventTopics as ReadonlyArray<string>).includes(value)
}

function toUserCreatedAttribution(
	attribution: FirstTouchAttribution | null | undefined,
): UserCreatedAttribution {
	const columns = firstTouchAttributionToUserColumns(
		hasFirstTouchAttribution(attribution)
			? attribution
			: emptyFirstTouchAttribution,
	)
	return {
		utm_source: columns.utm_source,
		utm_medium: columns.utm_medium,
		utm_campaign: columns.utm_campaign,
		utm_content: columns.utm_content,
		utm_term: columns.utm_term,
		landing_path: columns.first_touch_landing_path,
		referrer: columns.first_touch_referrer,
	}
}

export function buildUserCreatedEvent(input: {
	user: UserLifecycleIdentity
	source: UserCreatedSource
	createdAt: string
	attribution?: FirstTouchAttribution | null
}): UserCreatedEvent {
	return {
		event: userCreatedTopic,
		user: input.user,
		source: input.source,
		created_at: input.createdAt,
		attribution: toUserCreatedAttribution(input.attribution),
	}
}

const sqliteUtcTimestampPattern =
	/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/

/**
 * Normalizes a stored `users.created_at` value to the same ISO 8601 shape as
 * `deleted_at`. SQLite `CURRENT_TIMESTAMP` rows read as `YYYY-MM-DD HH:MM:SS`
 * in UTC with no zone, so they are treated as UTC. Values that cannot be
 * parsed are passed through unchanged rather than dropping the event.
 */
export function toUserLifecycleIsoTimestamp(value: string) {
	const trimmed = value.trim()
	const sqliteMatch = sqliteUtcTimestampPattern.exec(trimmed)
	const candidate = sqliteMatch
		? `${sqliteMatch[1]}T${sqliteMatch[2]}Z`
		: trimmed
	const parsed = new Date(candidate)
	return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString()
}

export function buildUserDeletedEvent(input: {
	user: UserLifecycleIdentity
	createdAt: string
	deletedAt: string
}): UserDeletedEvent {
	return {
		event: userDeletedTopic,
		user: input.user,
		created_at: toUserLifecycleIsoTimestamp(input.createdAt),
		deleted_at: input.deletedAt,
	}
}

export function buildUserLifecycleIdempotencyKey(input: {
	event: UserLifecycleEvent
	packageId: string
}) {
	switch (input.event.event) {
		case userCreatedTopic:
			return `user-lifecycle:${input.event.event}:${input.event.user.id}:${input.event.created_at}:${input.packageId}`
		case userDeletedTopic:
			return `user-lifecycle:${input.event.event}:${input.event.user.id}:${input.event.deleted_at}:${input.packageId}`
		default: {
			const exhaustive: never = input.event
			throw new Error(`Unsupported user lifecycle event: ${String(exhaustive)}`)
		}
	}
}
