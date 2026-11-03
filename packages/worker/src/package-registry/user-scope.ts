import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
type UsernameRow = {
	username?: unknown
}

function normalizePackageScopeUsername(value: unknown) {
	const username = normalizeUsername(value)
	const validationError = getUsernameFormatValidationError(username)
	if (validationError) {
		throw new Error(
			`Cannot validate package scope because the signed-in username is invalid: ${validationError}`,
		)
	}
	return username
}

export async function getPackageScopeByUserId(db: D1Database, userId: string) {
	const row = await db
		.prepare(
			`SELECT username
			FROM users
			WHERE stable_user_id = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(userId)
		.first<UsernameRow>()
	if (row) {
		return normalizePackageScopeUsername(row.username)
	}
	// Team orgs own packages under `orgs.id` with no matching `users` row; the
	// package scope is the org slug (same as resolvePackageOwnerContext).
	const org = await db
		.prepare(
			`SELECT slug
			FROM orgs
			WHERE id = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(userId)
		.first<{ slug?: unknown }>()
	if (!org?.slug || typeof org.slug !== 'string' || !org.slug.trim()) {
		throw new Error(
			'Cannot validate package scope because the signed-in user record was not found.',
		)
	}
	return normalizePackageScopeUsername(org.slug)
}

/**
 * Resolve the caller's personal package scope (username without "@").
 *
 * Identity is the MCP stable user id (`users.stable_user_id`), matching
 * `buildMcpUserContextFromGrantProps`. Looking up by email is wrong: a
 * concurrent email change (or any email/context drift) leaves the grant's
 * stable id intact but makes an email query miss the row.
 *
 * When auth already attached a validated username to the caller context, use
 * it — that snapshot is refreshed from D1 on every MCP/request auth path.
 */
export async function getMcpUserPackageScope(
	db: D1Database,
	user: McpUserContext,
) {
	const contextUsername = user.username?.trim()
	if (contextUsername) {
		return normalizePackageScopeUsername(contextUsername)
	}
	return getPackageScopeByUserId(db, user.userId)
}
