import {
	emptyFirstTouchAttribution,
	firstTouchAttributionToUserColumns,
	hasFirstTouchAttribution,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'

export const userCreatedTopic = 'user.created'
export const userDeletedTopic = 'user.deleted'
export const userGuestClaimedTopic = 'user.guest_claimed'

export const userLifecycleEventTopics = [
	userCreatedTopic,
	userDeletedTopic,
	userGuestClaimedTopic,
] as const

export type UserCreatedTopic = typeof userCreatedTopic
export type UserDeletedTopic = typeof userDeletedTopic
export type UserGuestClaimedTopic = typeof userGuestClaimedTopic
export type UserLifecycleEventTopic = (typeof userLifecycleEventTopics)[number]

export const userCreatedSources = ['signup', 'oauth', 'admin', 'guest'] as const
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

/** Present only when `source` is `guest`. */
export type UserCreatedGuest = {
	client_name: string | null
	expires_at: string
	delete_at: string
}

export type UserCreatedEvent = {
	event: UserCreatedTopic
	user: UserLifecycleIdentity
	source: UserCreatedSource
	created_at: string
	attribution: UserCreatedAttribution
	guest?: UserCreatedGuest
}

export type UserDeletedEvent = {
	event: UserDeletedTopic
	user: UserLifecycleIdentity
	/** Account signup time (ISO 8601), read before or at deletion. */
	created_at: string
	deleted_at: string
}

export type GuestClaimMode = 'new' | 'merge'
export type GuestClaimMethod =
	| 'social'
	| 'email_code'
	| 'signed_in_merge'
	| 'agent'

/** Non-deleted rows owned by the guest personal org at claim time. */
export type GuestClaimCounts = {
	packages: number
	repos: number
	memories: number
	secrets: number
	connections: number
	mcp_servers: number
	apps: number
	jobs: number
	webhooks: number
	runs: number
}

export type UserGuestClaimedEvent = {
	event: UserGuestClaimedTopic
	mode: GuestClaimMode
	user_created: boolean
	method: GuestClaimMethod
	provider: string | null
	/** The resulting account (the merge target for `merge`). */
	user: UserLifecycleIdentity
	guest: {
		id: string
		username: string
		client_name: string | null
		created_at: string
		expires_at: string
		claimed_at: string
		phase: 'active' | 'hold'
	}
	claimed_at: string
	counts: GuestClaimCounts
	renamed_packages: number
}

export type UserLifecycleEvent =
	| UserCreatedEvent
	| UserDeletedEvent
	| UserGuestClaimedEvent

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
	guest?: UserCreatedGuest
}): UserCreatedEvent {
	return {
		event: userCreatedTopic,
		user: input.user,
		source: input.source,
		created_at: input.createdAt,
		attribution: toUserCreatedAttribution(input.attribution),
		...(input.guest ? { guest: input.guest } : {}),
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

export function buildUserGuestClaimedEvent(input: {
	mode: GuestClaimMode
	method: GuestClaimMethod
	provider: string | null
	user: UserLifecycleIdentity
	guest: {
		id: string
		username: string
		clientName: string | null
		createdAt: string
		expiresAt: string
		phase: 'active' | 'hold'
	}
	claimedAt: string
	counts: GuestClaimCounts
	renamedPackages: number
}): UserGuestClaimedEvent {
	return {
		event: userGuestClaimedTopic,
		mode: input.mode,
		user_created: input.mode === 'new',
		method: input.method,
		provider: input.provider,
		user: input.user,
		guest: {
			id: input.guest.id,
			username: input.guest.username,
			client_name: input.guest.clientName,
			created_at: toUserLifecycleIsoTimestamp(input.guest.createdAt),
			expires_at: toUserLifecycleIsoTimestamp(input.guest.expiresAt),
			claimed_at: input.claimedAt,
			phase: input.guest.phase,
		},
		claimed_at: input.claimedAt,
		counts: input.counts,
		renamed_packages: input.renamedPackages,
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
		case userGuestClaimedTopic:
			return `user-lifecycle:${input.event.event}:${input.event.guest.id}:${input.event.claimed_at}:${input.packageId}`
		default: {
			const exhaustive: never = input.event
			throw new Error(`Unsupported user lifecycle event: ${String(exhaustive)}`)
		}
	}
}
