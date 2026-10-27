import {
	orgResourcePath,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

/** Public invite for the Kody community Discord. */
export const kodyDiscordInviteUrl = 'https://kcd.im/kody-discord'

const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

/** Owner + leaf of a scoped package URL (`/@owner/kody-id`). */
export type PackageScope = {
	ownerUsername: string
	kodyId: string
}

/**
 * Owner half of a scoped package name (`@owner/kody-id`), or null when the name
 * carries no scope. Listing names carry the owner, so surfaces that only hold a
 * name can still build a canonical URL.
 */
export function parseListingOwnerUsername(name: string) {
	const match = scopedPackageNamePattern.exec(name.trim())
	return match?.[1] ?? null
}

/**
 * Resolve `{ ownerUsername, kodyId }` from a scoped package name. Prefer this
 * over the signed-in person's handle when building package or org section
 * links from list rows — the package's scope is the owner, not the viewer.
 */
export function packageScopeFromName(name: string): PackageScope | null {
	const ownerUsername = parseListingOwnerUsername(name)
	if (!ownerUsername) return null
	const kodyId = name.trim().slice(`@${ownerUsername}/`.length)
	if (!kodyId) return null
	return { ownerUsername, kodyId }
}

/**
 * Prefer the owner encoded in `packageName`; otherwise use an explicit owner
 * + leaf (for rows that only carry `kodyId`, such as workflows).
 */
export function packageScopeFromNameOrOwner(input: {
	packageName?: string | null
	ownerUsername?: string | null
	kodyId?: string | null
}): PackageScope | null {
	if (input.packageName) {
		const fromName = packageScopeFromName(input.packageName)
		if (fromName) return fromName
	}
	const ownerUsername = input.ownerUsername?.trim() || null
	const kodyId = input.kodyId?.trim() || null
	if (!ownerUsername || !kodyId) return null
	return { ownerUsername, kodyId }
}

/**
 * Org slug stamped on the bound request, else the person's handle. Use for
 * page-level owner fields and for package links when the row has no scoped
 * name. Never use the person's signup handle alone for team-org list pages.
 */
export function boundOrgSlugForUrls(user: {
	username: string
	request: { org: { slug?: string | null } }
}) {
	return user.request.org.slug?.trim() || user.username.trim()
}

/** Canonical `/@owner/kody-id` for a resolved package scope. */
export function packageHrefFromScope(scope: PackageScope) {
	return routes.communityPackage.href({
		username: scope.ownerUsername,
		kodyId: scope.kodyId,
	})
}

/** Canonical `/@owner/kody-id/settings` for a resolved package scope. */
export function packageSettingsHrefFromScope(scope: PackageScope) {
	return routes.communityPackageSettings.href({
		username: scope.ownerUsername,
		kodyId: scope.kodyId,
	})
}

/** Canonical `/@owner/kody-id/approve-publish` for a resolved package scope. */
export function packageApprovePublishHrefFromScope(scope: PackageScope) {
	return routes.communityPackageApprovePublish.href({
		username: scope.ownerUsername,
		kodyId: scope.kodyId,
	})
}

/**
 * Org-scoped account section under the package owner's slug:
 * `/@owner/-/<section>`.
 */
export function orgSectionHrefFromPackageScope(
	scope: PackageScope,
	section: OrgOwnedAccountSection,
	rest = '',
) {
	return orgResourcePath(scope.ownerUsername, section, rest)
}

/** Canonical `/@owner/kody-id` for a scoped package name, or null. */
export function getCommunityPackageHrefFromName(name: string) {
	const scope = packageScopeFromName(name)
	return scope ? packageHrefFromScope(scope) : null
}

/**
 * Read-only smart HTTP clone URL for a public listing: `/@owner/kody-id.git`.
 * Append `.git` to the canonical package href. Private packages 404 on this
 * route; push is rejected.
 */
export function getCommunityPackageGitHref(input: {
	username: string
	kodyId: string
}) {
	return `${packageHrefFromScope({
		ownerUsername: input.username,
		kodyId: input.kodyId,
	})}.git`
}

/**
 * The canonical, shareable URL for a community listing: `/@owner/kody-id`.
 * The listing-uuid URL still resolves and redirects here, so it stays the
 * fallback for the surfaces that hold a listing id without its owner's name.
 */
export function getCommunityListingHref(input: {
	listingId: string
	/** Falls back to the owner encoded in `listingName` when omitted. */
	ownerUsername?: string | null
	listingName?: string | null
	kodyId?: string | null
}) {
	const scope = packageScopeFromNameOrOwner({
		packageName: input.listingName,
		ownerUsername: input.ownerUsername,
		kodyId: input.kodyId,
	})
	return scope
		? packageHrefFromScope(scope)
		: routes.communityDetail.href({ listingId: input.listingId })
}
