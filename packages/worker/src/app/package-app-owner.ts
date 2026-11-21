/**
 * soft-delete-read-filter: opt-out
 *
 * Invalidation must resolve soft-deleted users by id; resolve still refuses
 * tombstoned owners via `users.deleted_at` below.
 */
import { isSessionInvalidatedByStoredPasswordChange } from '#app/request-auth-cache.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import {
	invokeContractFreshnessCacheLimit,
	invokeContractFreshnessTtlMs,
} from '#worker/package-invocations/invoke-contract-cache.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { memoizePerRequest } from '#worker/request-context.ts'
import {
	parsePersonId,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * The account a hosted package app runs on behalf of.
 *
 * Package apps only ever serve their owner, so this is intentionally a much
 * narrower identity than `AuthenticatedAppUser`: no roles, no permissions, and
 * nothing that would let the package-app origin act on first-party surfaces.
 */
export type PackageAppOwner = {
	/** Stable (hashed) user id used for every userId-scoped read. */
	userId: OwnerId
	/** `users.personal_org_id`, so callers can tell a personal-org visit. */
	personalOrgId: OwnerId
	username: string
	email: string
	displayName: string
}

/**
 * User row fields cached per stable user id for package-app owner resolution.
 * Security-sensitive columns stay on the snapshot so each request re-applies
 * suspend/delete/password checks against the cached values; password and
 * account-state mutations invalidate eagerly.
 */
type CachedPackageAppOwnerRow = {
	userId: OwnerId
	personalOrgId: OwnerId
	username: string
	email: string
	deletingAt: string | null
	suspendedAt: string | null
	passwordChangedAt: string | null
}

/**
 * Per-isolate cache for package-app owner D1 lookups. Same 15 s TTL as invoke
 * freshness tier: the isolate that runs a user mutation invalidates eagerly, so
 * same-isolate staleness is zero; TTL only bounds other isolates until they
 * re-read D1.
 */
const packageAppOwnerRowCache =
	new PromiseLruCache<CachedPackageAppOwnerRow | null>({
		ttlMs: invokeContractFreshnessTtlMs,
		limit: invokeContractFreshnessCacheLimit,
	})

/**
 * The org a hosted package app runs as, resolved from the public handle
 * (`{slug}.kody.run` or `/@{slug}/packages/...`). Personal and team orgs both
 * resolve here. Session validity still uses
 * {@link resolvePackageAppOwnerByStableUserId} for the visiting person.
 */
export type PackageAppOrgOwner = {
	userId: OwnerId
	username: string
	displayName: string
}

/**
 * Per-isolate cache for handle → org resolution on the package-app serving
 * path, same 15 s freshness tier as the owner row cache. Every package-app
 * request (HTML and `/_assets`) names its org by handle, so without this each
 * one pays the handle and org reads. Misses are not retained across requests,
 * so a just-created handle serves on its next request.
 */
const packageAppOrgOwnerCache = new PromiseLruCache<PackageAppOrgOwner | null>({
	ttlMs: invokeContractFreshnessTtlMs,
	limit: invokeContractFreshnessCacheLimit,
})

export async function resolvePackageAppOrgOwnerByHandle(input: {
	env: Env
	handle: string
}): Promise<PackageAppOrgOwner | null> {
	const cacheKey = input.handle.trim().toLowerCase()
	// One package-app request resolves its handle from several steps (profile
	// app check, retired slug redirect, serve). The request memo keeps a miss
	// to one handle and org read per request.
	return await memoizePerRequest({
		key: `package-app-org-owner:${cacheKey}`,
		load: () =>
			packageAppOrgOwnerCache.getOrCreate({
				cacheKey,
				create: async () => {
					const identity = await findPublicOwnerIdentityByHandle({
						db: input.env.APP_DB,
						handle: input.handle,
					})
					const org = identity
						? await getOrgById(input.env.APP_DB, identity.ownerId)
						: null
					if (!identity || !org) {
						packageAppOrgOwnerCache.delete(cacheKey)
						return null
					}
					return {
						userId: identity.ownerId,
						username: identity.handle,
						displayName: org.display_name?.trim() || org.slug,
					}
				},
			}),
	})
}

export function invalidatePackageAppOwnerCache(input: {
	stableUserId: string
}) {
	packageAppOwnerRowCache.delete(input.stableUserId)
}

/**
 * Best-effort invalidation when only the numeric D1 user id is known.
 * Never throws: write paths that call this (purge claim, signup rollback)
 * must not fail because of a cache SELECT.
 */
export async function invalidatePackageAppOwnerCacheForDbUserId(
	db: D1Database,
	dbUserId: number,
) {
	try {
		// Include soft-deleted users: invalidation must clear cache after
		// soft-delete even though live reads hide the tombstoned row.
		const row = await db
			.prepare(`SELECT stable_user_id FROM users WHERE id = ?`)
			.bind(dbUserId)
			.first<{ stable_user_id: string }>()
		if (row?.stable_user_id) {
			invalidatePackageAppOwnerCache({ stableUserId: row.stable_user_id })
		}
	} catch (error) {
		console.warn('package-app-owner-cache-invalidate-failed', error)
	}
}

function packageAppOwnerFromCachedRow(input: {
	row: CachedPackageAppOwnerRow
	issuedAt: number
}): PackageAppOwner | null {
	if (input.row.deletingAt || input.row.suspendedAt) return null
	if (
		isSessionInvalidatedByStoredPasswordChange({
			issuedAt: input.issuedAt,
			storedPasswordChangedAt: input.row.passwordChangedAt,
		})
	) {
		return null
	}
	return {
		userId: input.row.userId,
		personalOrgId: input.row.personalOrgId,
		username: input.row.username,
		email: input.row.email,
		displayName: resolveDisplayName({
			email: input.row.email,
			username: input.row.username,
		}),
	}
}

async function loadPackageAppOwnerRowWithCache(input: {
	env: Env
	stableUserId: string
}): Promise<CachedPackageAppOwnerRow | null> {
	const cacheKey = input.stableUserId
	return await packageAppOwnerRowCache.getOrCreate({
		cacheKey,
		create: async () => {
			const db = createDb(input.env.APP_DB)
			const userRecord = await db.findOne(usersTable, {
				where: { stable_user_id: input.stableUserId },
			})
			if (!userRecord) {
				// Do not retain misses: a just-created user must be visible on the
				// next lookup instead of after the TTL.
				packageAppOwnerRowCache.delete(cacheKey)
				return null
			}
			// findOne can still return a soft-deleted row; refuse tombstones.
			if (userRecord.deleted_at) {
				packageAppOwnerRowCache.delete(cacheKey)
				return null
			}
			return {
				userId: personalOrgId(personIdFromStored(userRecord.stable_user_id)),
				personalOrgId: personalOrgIdFromUserRow(userRecord),
				username: userRecord.username,
				email: userRecord.email,
				deletingAt: userRecord.deleting_at ?? null,
				suspendedAt: userRecord.suspended_at ?? null,
				passwordChangedAt: userRecord.password_changed_at ?? null,
			}
		},
	})
}

/**
 * Resolve a package-app owner from a package-app session payload.
 *
 * Fails closed exactly like browser session resolution: unknown accounts,
 * accounts being deleted, suspended accounts, and sessions issued at or before
 * a password change are all refused.
 */
export async function resolvePackageAppOwnerByStableUserId(input: {
	env: Env
	stableUserId: string
	issuedAt: number
}): Promise<PackageAppOwner | null> {
	if (!parsePersonId(input.stableUserId)) return null

	const row = await loadPackageAppOwnerRowWithCache({
		env: input.env,
		stableUserId: input.stableUserId,
	})
	if (!row) return null

	return packageAppOwnerFromCachedRow({
		row,
		issuedAt: input.issuedAt,
	})
}
