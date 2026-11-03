/**
 * Per-isolate cache of the MCP auth decisions that cost extra D1 round trips
 * to derive (global RBAC roles/permissions and the grant's org binding),
 * keyed by bearer token.
 *
 * The normalized tables stay the source of truth. An entry is only used when
 * the personal org's and the bound org's `access_epoch`, read in the same D1
 * transaction as the user row every auth gate checks, still equal the epochs
 * the entry was derived from. Every write that can change a role, membership,
 * grant, or team bumps the owning org's epoch in the same batch (see
 * orgs/access-writes.ts, orgs/offboarding.ts, identity/permissions-db.ts), so
 * a change is visible to the next request in every isolate. There is no TTL.
 *
 * Identity, verification, suspension, password-change and deletion flags are
 * never cached: they come from the fresh user row on every request.
 */
import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import type { OrgBinding } from '#worker/orgs/repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type McpAuthCacheEntry = {
	/** `users.id` the entry was derived from; a reassigned stable id misses. */
	userRowId: number
	personalOrgEpoch: number
	boundOrgId: string
	boundOrgEpoch: number
	roles: NonNullable<McpUserContext['roles']>
	permissions: NonNullable<McpUserContext['permissions']>
	orgBinding: OrgBinding | null
}

/** Live (not soft-deleted) org row; a deleted org yields no row and misses. */
export type OrgEpochRow = {
	access_epoch: number
	deleting_at: string | null
	suspended_at: string | null
}

const maxEntries = 2000
const entries = new Map<string, McpAuthCacheEntry>()

export function readMcpAuthCache(token: string): McpAuthCacheEntry | null {
	return entries.get(token) ?? null
}

export function writeMcpAuthCache(token: string, entry: McpAuthCacheEntry) {
	entries.delete(token)
	if (entries.size >= maxEntries) {
		const oldest = entries.keys().next()
		if (!oldest.done) entries.delete(oldest.value)
	}
	entries.set(token, entry)
}

export function evictMcpAuthCache(token: string | null | undefined) {
	if (token) entries.delete(token)
}

export function mcpAuthCacheSizeForTests() {
	return entries.size
}

export function clearMcpAuthCacheForTests() {
	entries.clear()
}

export function orgEpochStatement(db: D1Database, orgId: string) {
	return db
		.prepare(
			`SELECT access_epoch, deleting_at, suspended_at
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
}

export function orgEpochFromRow(row: OrgEpochRow | null): number | null {
	if (!row) return null
	return Number(row.access_epoch) || 0
}

/**
 * True when `entry` was derived from the same user row and the same org
 * epochs the current transaction observed. A bound org that is no longer
 * active (soft-deleted or suspended) misses so the binding is recomputed
 * (and found to be null) the same way the uncached read would.
 */
export function mcpAuthCacheEntryMatches(input: {
	entry: McpAuthCacheEntry
	userRowId: number
	boundOrgId: string
	personalOrg: OrgEpochRow | null
	boundOrg: OrgEpochRow | null
}): boolean {
	const { entry, personalOrg, boundOrg } = input
	if (entry.userRowId !== input.userRowId) return false
	if (entry.boundOrgId !== input.boundOrgId) return false
	if (!personalOrg || !boundOrg) return false
	if (boundOrg.suspended_at) return false
	return (
		orgEpochFromRow(personalOrg) === entry.personalOrgEpoch &&
		orgEpochFromRow(boundOrg) === entry.boundOrgEpoch
	)
}
