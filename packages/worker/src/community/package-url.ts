import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { routes } from '#universal/routes.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
} from '#worker/package-registry/repo.ts'
import {
	kodyPackageIdPattern,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	getCommunityListingByOwnerAndKodyId,
	getCommunityListingByOwnerAndPackage,
} from './repo.ts'

/**
 * Canonical public URL of a published package: `/@owner/kody-id`. Both halves
 * are renameable, so a URL that no longer resolves directly is followed through
 * the retirement tables below before it is treated as missing.
 */
export function getCommunityPackageHref(input: {
	username: string
	kodyId: string
}) {
	return routes.communityPackage.href({
		username: input.username,
		kodyId: input.kodyId,
	})
}

export type CommunityPackageUrlTarget =
	| { kind: 'listing'; listingId: string; username: string; kodyId: string }
	// The requested pair is retired (or not canonically spelled); `username` and
	// `kodyId` are the pair that owns the package now, and `listingId` is the
	// listing that pair resolves to — a caller redirecting *to* the canonical URL
	// can check it lands on the listing it started from.
	| { kind: 'redirect'; listingId: string; username: string; kodyId: string }

export type PackagePageUrlTarget =
	| {
			kind: 'package'
			username: string
			kodyId: string
			userId: OwnerId
			savedPackage: SavedPackageRecord | null
			listingId: string | null
			listingKodyId: string | null
	  }
	| {
			kind: 'redirect'
			username: string
			kodyId: string
			userId: OwnerId
			packageId: string
			listingId: string | null
			listingKodyId: string | null
	  }

function normalizeSlug(value: string) {
	return value.trim().toLowerCase()
}

/**
 * The package a URL slug addresses: the live owner of the slug, or the package
 * that retired it. `retired` means the slug now redirects elsewhere.
 */
async function findSavedPackageForSlug(input: {
	db: D1Database
	ownerUserId: string
	slug: string
}): Promise<{ savedPackage: SavedPackageRecord; retired: boolean } | null> {
	const savedPackage = await resolveSavedPackageRef(input.db, {
		userId: input.ownerUserId,
		ref: input.slug,
		match: 'slug',
		followRedirects: true,
	})
	if (!savedPackage) return null
	return {
		savedPackage,
		retired: getPackageNameLeaf(savedPackage.name) !== input.slug,
	}
}

/**
 * The active listing published at a URL slug, plus the package the slug
 * addresses. A listing keeps its slug until republish, even after another
 * package takes that local slug, so the slug's package is dropped rather than
 * paired with a listing it does not belong to.
 */
async function findListingAndSavedPackageForSlug(input: {
	db: D1Database
	ownerUserId: string
	slug: string
}) {
	const [listingAtSlug, found] = await Promise.all([
		getCommunityListingByOwnerAndKodyId(input.db, {
			ownerUserId: input.ownerUserId,
			kodyId: input.slug,
		}),
		findSavedPackageForSlug(input),
	])
	const belongsToListing =
		!listingAtSlug || found?.savedPackage.id === listingAtSlug.packageId
	return { listingAtSlug, found: belongsToListing ? found : null }
}

async function getActiveListingForPackage(input: {
	db: D1Database
	ownerUserId: string
	packageId: string
}) {
	const listing = await getCommunityListingByOwnerAndPackage(input.db, input)
	return listing?.status === 'active' ? listing : null
}

/**
 * Resolve `/@username/slug` to the listing it addresses, or to the canonical
 * pair a moved package now lives at. Returns null when nothing owns the pair,
 * which the caller renders as a 404 — never as a redirect, so a retired pair
 * cannot be used to bounce visitors at an unrelated package.
 */
export async function resolveCommunityPackageUrl(input: {
	db: D1Database
	username: string
	kodyId: string
}): Promise<CommunityPackageUrlTarget | null> {
	const requestedUsername = input.username.trim()
	const requestedSlug = input.kodyId.trim()
	const username = normalizeUsername(requestedUsername)
	const slug = normalizeSlug(requestedSlug)
	if (!username || !kodyPackageIdPattern.test(slug)) return null

	// A pair that differs only in spelling still moves the visitor, so the
	// canonical form is served from one URL instead of several.
	const moved = username !== requestedUsername || slug !== requestedSlug

	{
		const identity = await findPublicOwnerIdentityByHandle({
			db: input.db,
			handle: username,
		})
		if (identity) {
			const { listingAtSlug, found } = await findListingAndSavedPackageForSlug({
				db: input.db,
				ownerUserId: identity.ownerId,
				slug,
			})
			const listing =
				listingAtSlug ??
				(found
					? await getActiveListingForPackage({
							db: input.db,
							ownerUserId: identity.ownerId,
							packageId: found.savedPackage.id,
						})
					: null)
			if (!listing) return null
			// The listing pair stays the public URL until republish, so a moved
			// package lands on the listing slug, not its unpublished local one.
			return {
				kind: moved || listing.kodyId !== slug ? 'redirect' : 'listing',
				listingId: listing.id,
				username: identity.handle,
				kodyId: listing.kodyId,
			}
		}
	}
	return null
}

/**
 * Resolve `/@username/slug` to a saved package and optional community
 * listing. Used by the canonical package page so owners can open unpublished
 * packages at the same URL visitors use for listings.
 */
export async function resolvePackagePageUrl(input: {
	db: D1Database
	username: string
	kodyId: string
}): Promise<PackagePageUrlTarget | null> {
	const requestedUsername = input.username.trim()
	const requestedSlug = input.kodyId.trim()
	const username = normalizeUsername(requestedUsername)
	const slug = normalizeSlug(requestedSlug)
	if (!username || !kodyPackageIdPattern.test(slug)) return null

	const moved = username !== requestedUsername || slug !== requestedSlug

	{
		const identity = await findPublicOwnerIdentityByHandle({
			db: input.db,
			handle: username,
		})
		if (identity) {
			const ownerUserId = identity.ownerId
			const { listingAtSlug, found } = await findListingAndSavedPackageForSlug({
				db: input.db,
				ownerUserId,
				slug,
			})
			let savedPackage = found && !found.retired ? found.savedPackage : null
			// Listing `kody_id` only moves on republish, so a slug can still
			// address a listing whose package has a new local slug.
			const listing =
				listingAtSlug ??
				(savedPackage
					? await getActiveListingForPackage({
							db: input.db,
							ownerUserId,
							packageId: savedPackage.id,
						})
					: null)
			if (!savedPackage && listing) {
				savedPackage = await getSavedPackageById(input.db, {
					userId: ownerUserId,
					packageId: listing.packageId,
				})
			}
			const packageId = savedPackage?.id ?? listing?.packageId
			if (packageId) {
				const listingKodyId = listing?.kodyId ?? null
				const savedSlug = savedPackage
					? getPackageNameLeaf(savedPackage.name)
					: null
				// Public pair is the listing slug until republish. The saved
				// package's local slug can move first and must not become the
				// shared redirect target.
				const publicSlug = listingKodyId ?? savedSlug ?? slug
				const servedSlug =
					listingKodyId === slug ? listingKodyId : (savedSlug ?? publicSlug)
				return moved
					? {
							kind: 'redirect',
							username: identity.handle,
							kodyId: publicSlug,
							userId: ownerUserId,
							packageId,
							listingId: listing?.id ?? null,
							listingKodyId,
						}
					: {
							kind: 'package',
							username: identity.handle,
							kodyId: servedSlug,
							userId: ownerUserId,
							savedPackage,
							listingId: listing?.id ?? null,
							listingKodyId,
						}
			}

			if (!found) return null
			const currentListing = await getActiveListingForPackage({
				db: input.db,
				ownerUserId,
				packageId: found.savedPackage.id,
			})
			return {
				kind: 'redirect',
				username: identity.handle,
				kodyId:
					currentListing?.kodyId ?? getPackageNameLeaf(found.savedPackage.name),
				userId: ownerUserId,
				packageId: found.savedPackage.id,
				listingId: currentListing?.id ?? null,
				listingKodyId: currentListing?.kodyId ?? null,
			}
		}
	}
	return null
}

// New retire rows write only `package_slug_redirects` (#1909 phase 2). Release
// and delete still clear leftover `package_kody_id_redirects` rows so a claimed
// slug cannot keep redirecting through the legacy read fallback. Reads try the
// slug table first; the legacy table drops in phase 4 (Kent gate).
const packageSlugRedirectWriteTable = {
	table: 'package_slug_redirects',
	slugColumn: 'old_slug',
} as const

const packageSlugRedirectCleanupTables = [
	packageSlugRedirectWriteTable,
	{ table: 'package_kody_id_redirects', slugColumn: 'old_kody_id' },
] as const

/**
 * Claim a slug for a package: any retirement row pointing away from it was
 * left by a package that no longer owns the name, and letting it stand would
 * forward the new package's own URL to an unrelated one.
 */
export async function releasePackageSlugRedirect(input: {
	db: D1Database
	userId: string
	slug: string
}) {
	const slug = normalizeSlug(input.slug)
	if (!slug) return
	await input.db.batch(
		packageSlugRedirectCleanupTables.map(({ table, slugColumn }) =>
			input.db
				.prepare(`DELETE FROM ${table} WHERE user_id = ? AND ${slugColumn} = ?`)
				.bind(input.userId, slug),
		),
	)
}

/**
 * Retire the slug a package just moved away from, so links shared under the
 * old slug follow the package to its new one.
 */
export async function retirePackageSlug(input: {
	db: D1Database
	userId: string
	packageId: string
	oldSlug: string
	newSlug: string
}) {
	const oldSlug = normalizeSlug(input.oldSlug)
	const newSlug = normalizeSlug(input.newSlug)
	if (!oldSlug || oldSlug === newSlug) return
	const { table, slugColumn } = packageSlugRedirectWriteTable
	await input.db.batch([
		// Drop any leftover legacy row for the new live slug so it cannot
		// shadow the package through the read fallback.
		...packageSlugRedirectCleanupTables.map(
			({ table: cleanupTable, slugColumn: cleanupColumn }) =>
				input.db
					.prepare(
						`DELETE FROM ${cleanupTable} WHERE user_id = ? AND ${cleanupColumn} = ?`,
					)
					.bind(input.userId, newSlug),
		),
		input.db
			.prepare(
				`INSERT INTO ${table} (user_id, ${slugColumn}, package_id)
				VALUES (?, ?, ?)
				ON CONFLICT (user_id, ${slugColumn}) DO UPDATE SET
					package_id = excluded.package_id,
					created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
			)
			.bind(input.userId, oldSlug, input.packageId),
	])
}

/**
 * Retired URL leaves that still forward to this package. Used to clear the
 * package-app slug freshness cache before the redirect rows are deleted.
 */
export async function listPackageSlugRedirects(input: {
	db: D1Database
	userId: string
	packageId: string
}): Promise<Array<string>> {
	const rows = await input.db
		.prepare(
			`SELECT old_slug AS slug FROM package_slug_redirects
			 WHERE user_id = ? AND package_id = ?
			 UNION
			 SELECT old_kody_id AS slug FROM package_kody_id_redirects
			 WHERE user_id = ? AND package_id = ?`,
		)
		.bind(input.userId, input.packageId, input.userId, input.packageId)
		.all<{ slug: string }>()
	return [
		...new Set(
			(rows.results ?? [])
				.map((row) => row.slug.trim())
				.filter((slug) => slug.length > 0),
		),
	]
}

/**
 * Deleting a package releases every slug it retired: the slugs no longer lead
 * anywhere, and keeping them would let a later package inherit another
 * package's redirect history.
 */
export async function deletePackageSlugRedirects(input: {
	db: D1Database
	userId: string
	packageId: string
}) {
	await input.db.batch(
		packageSlugRedirectCleanupTables.map(({ table }) =>
			input.db
				.prepare(`DELETE FROM ${table} WHERE user_id = ? AND package_id = ?`)
				.bind(input.userId, input.packageId),
		),
	)
}
