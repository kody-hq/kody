/**
 * soft-delete-read-filter: opt-out — person lookup reads `users.deleted_at`
 * so a tombstoned person cannot fall through to a leftover personal org row.
 */
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { AccountSuspendedError } from '#worker/account/account-suspension.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { getUserRolesAndPermissions } from './permissions-db.ts'
import { resolveDisplayName } from './username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const backgroundMcpUserCacheTtlMs = 60_000
const backgroundMcpUserCacheMaxEntries = 1_000

type BackgroundMcpUserCacheEntry = {
	value: Promise<McpUserContext>
	expiresAtMs: number
}

const backgroundMcpUserCachesByDb = new WeakMap<
	D1Database,
	Map<string, BackgroundMcpUserCacheEntry>
>()

function isMissingRbacTableError(error: unknown) {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	return (
		message.includes('no such table: user_roles') ||
		message.includes('no such table: roles') ||
		message.includes('no such table: role_permissions') ||
		message.includes('no such table: permissions')
	)
}

function backgroundMcpUserNotFound(userId: string) {
	return new Error(`Background MCP user was not found: ${userId}`)
}

function isMissingOrgsTableError(error: unknown) {
	return error instanceof Error && /no such table:\s*orgs/i.test(error.message)
}

/**
 * Person accounts and team orgs share the owner-id space that package jobs,
 * invokes, and saved-package projection pass into this lookup. A live team
 * org has no `users` row. Resolve that id as the org here so callers do not
 * each decide between a person and an org. A person id still wins: a deleting
 * or soft-deleted user is missing even when a personal org remains.
 */
async function loadBackgroundTeamOrg(
	db: D1Database,
	ownerId: string,
): Promise<McpUserContext> {
	let org: {
		slug: string
		display_name: string | null
		suspended_at: string | null
		deleting_at: string | null
	} | null
	try {
		org = await db
			.prepare(
				`SELECT slug, display_name, suspended_at, deleting_at
				 FROM orgs
				 WHERE id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(ownerId)
			.first<{
				slug: string
				display_name: string | null
				suspended_at: string | null
				deleting_at: string | null
			}>()
	} catch (error) {
		if (isMissingOrgsTableError(error)) {
			throw backgroundMcpUserNotFound(ownerId)
		}
		throw error
	}
	if (!org || org.deleting_at) {
		throw backgroundMcpUserNotFound(ownerId)
	}
	if (org.suspended_at) {
		throw new AccountSuspendedError()
	}
	const displayName = org.display_name?.trim() || org.slug
	return {
		userId: personIdFromStored(ownerId),
		email: '',
		username: org.slug,
		displayName,
		roles: ['user'],
		permissions: [],
	}
}

async function loadBackgroundMcpUser(
	db: D1Database,
	userId: string,
): Promise<McpUserContext> {
	const user = await db
		.prepare(
			`SELECT id, email, username, display_name, stable_user_id,
				personal_org_id, suspended_at, deleting_at, deleted_at
			 FROM users
			 WHERE stable_user_id = ? OR personal_org_id = ?`,
		)
		.bind(userId, userId)
		.first<{
			id: number
			email: string
			username: string
			display_name: string | null
			stable_user_id: string
			personal_org_id: string | null
			suspended_at: string | null
			deleting_at: string | null
			deleted_at: string | null
		}>()
	if (!user) {
		return await loadBackgroundTeamOrg(db, userId)
	}
	if (user.deleting_at || user.deleted_at) {
		throw backgroundMcpUserNotFound(userId)
	}
	if (user.suspended_at) {
		throw new AccountSuspendedError()
	}
	const profileDisplayName = user.display_name?.trim()

	// Package jobs filter the capability registry by role.
	// Omitting roles hides admin_* tools as "not found" even for admin owners.
	let roles: McpUserContext['roles'] = []
	let permissions: McpUserContext['permissions'] = []
	try {
		;({ roles, permissions } = await getUserRolesAndPermissions(db, user.id))
	} catch (error) {
		if (!isMissingRbacTableError(error)) {
			console.error('Failed to load roles for background MCP user:', error)
		}
	}
	// Some test / pre-RBAC schemas have roles + user_roles but no permission
	// tables; still surface role membership for capability filtering.
	if ((roles?.length ?? 0) === 0) {
		try {
			const roleResult = await db
				.prepare(
					`SELECT DISTINCT r.name AS role_name
					 FROM user_roles ur
					 INNER JOIN roles r ON r.id = ur.role_id
					 WHERE ur.user_id = ?`,
				)
				.bind(user.id)
				.all<{ role_name: string }>()
			roles = (roleResult.results ?? [])
				.map((row) => row.role_name)
				.filter(
					(name): name is 'user' | 'admin' =>
						name === 'user' || name === 'admin',
				)
				.sort()
		} catch (error) {
			if (!isMissingRbacTableError(error)) {
				console.error(
					'Failed to load role names for background MCP user:',
					error,
				)
			}
		}
	}

	const personId = personIdFromStored(user.stable_user_id)
	return {
		userId: personId,
		email: user.email,
		username: user.username,
		displayName:
			profileDisplayName ||
			resolveDisplayName({
				email: user.email,
				username: user.username,
			}),
		personalOrgId: personalOrgIdFromUserRow({
			personal_org_id: user.personal_org_id,
			stable_user_id: user.stable_user_id,
		}),
		roles,
		permissions,
	}
}

/**
 * Resolve account identity for background execution from an owner id.
 *
 * The id is a person (`users.stable_user_id`), that person's personal org
 * (`users.personal_org_id`), or a team org (`orgs.id` with no users row).
 * This is the only place that distinction is made. Callers keep passing the
 * storage owner id.
 *
 * This is the suspension choke point for background lanes (jobs, package
 * invocations and subscriptions, workflows, realtime hooks):
 * a suspended person or team org throws `AccountSuspendedError` instead of
 * resolving.
 *
 * The short per-binding cache deduplicates nested and bursty package calls
 * while allowing account profile changes to propagate without isolate-wide
 * invalidation machinery, so a new suspension reaches an isolate that already
 * cached the account within the cache TTL. Rejected reads (including
 * suspension) are evicted immediately, so unsuspending takes effect at once.
 */
export async function resolveBackgroundMcpUser(
	db: D1Database,
	userId: string,
): Promise<McpUserContext> {
	let cache = backgroundMcpUserCachesByDb.get(db)
	if (!cache) {
		cache = new Map()
		backgroundMcpUserCachesByDb.set(db, cache)
	}
	const nowMs = Date.now()
	const existing = cache.get(userId)
	if (existing && existing.expiresAtMs > nowMs) {
		return await existing.value
	}
	const value = loadBackgroundMcpUser(db, userId)
	value.catch(() => {
		if (cache.get(userId)?.value === value) cache.delete(userId)
	})
	if (cache.size >= backgroundMcpUserCacheMaxEntries) {
		const oldestKey = cache.keys().next().value
		if (oldestKey !== undefined) cache.delete(oldestKey)
	}
	cache.set(userId, {
		value,
		expiresAtMs: nowMs + backgroundMcpUserCacheTtlMs,
	})
	return await value
}
