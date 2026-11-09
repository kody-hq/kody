/**
 * Frozen Durable Object `idFromName` builders for user-owned (and documented
 * exception) objects. Changing any of these strings or tuple layouts creates
 * new objects and strands existing object storage. See
 * `docs/contributing/architecture/data-storage.md` (§ Durable Object id
 * contracts).
 *
 * JSON-tuple names use {@link durableObjectNameFromParts} so components that
 * may contain `/` or `:` round-trip unambiguously.
 *
 * Callers pass an `OwnerId` they already have (`request.org.id`, or a storage
 * read that branded the id). These builders do not brand and, except
 * McpClientHub, do not trim: RunLog, UserMeter, Mailbox, RepoSessionIndex,
 * and JobManager names are the stored id bytes.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Encode Durable Object name parts as a JSON tuple. Prefer the typed helpers
 * below at call sites; use this only when building a new user-scoped DO name
 * that is not yet covered by a dedicated helper.
 */
export function durableObjectNameFromParts(
	parts: ReadonlyArray<string>,
): string {
	return JSON.stringify(parts)
}

/** JobManager — one scheduler DO per user. */
export function jobManagerDurableObjectName(userId: OwnerId) {
	return userId
}

/** RunLog — one execution-history DO per user. */
export function runLogDurableObjectName(userId: OwnerId) {
	return userId
}

/** UserMeter — one daily-entitlement meter DO per user (untrimmed, like RunLog). */
export function userMeterDurableObjectName(userId: OwnerId) {
	return userId
}

/** StripePlanRefresh — one activity-driven refresh alarm per user. */
export function stripePlanRefreshDurableObjectName(userId: OwnerId) {
	return userId
}

/** Mailbox — one email-metadata DO per user (untrimmed, like RunLog). */
export function mailboxDurableObjectName(userId: OwnerId) {
	return userId
}

/** RepoSessionIndex — one catalog DO per user (untrimmed, like RunLog). */
export function repoSessionIndexDurableObjectName(userId: OwnerId) {
	return userId
}

/** McpClientHub — one client-hub DO per user (trimmed). */
export function mcpClientHubDurableObjectName(userId: OwnerId) {
	return userId.trim()
}

/** StorageRunner — isolated SQLite DO per (userId, storageId). */
export function storageRunnerDurableObjectName(
	userId: OwnerId,
	storageId: string,
) {
	return durableObjectNameFromParts([userId, storageId])
}

/** PackageRealtimeSession — live app session DO per (userId, packageId). */
export function packageRealtimeSessionDurableObjectName(input: {
	userId: OwnerId
	packageId: string
}) {
	return durableObjectNameFromParts([input.userId, input.packageId])
}

/**
 * RepoSession is keyed by session id only (not user-prefixed). Every RPC
 * must validate the catalog row's `user_id` (RepoSessionIndex, one object
 * per user) before touching the workspace. Account deletion enumerates the
 * user's session ids from the index before purging each workspace DO.
 * Documented exception to user-scoped naming — do not "fix" this by
 * prefixing userId without a storage migration plan.
 */
export function repoSessionDurableObjectName(sessionId: string) {
	return sessionId
}
