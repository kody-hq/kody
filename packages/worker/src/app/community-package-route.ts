import { loadPackagePage } from '#app/package-page.ts'
import {
	getCommunityPackageHref,
	resolveCommunityPackageUrl,
} from '#worker/community/package-url.ts'
import {
	fallbackDefaultBranchName,
	getCommunityPackageFilesHref,
	getPackageTreeHref,
	isPublicTreeDefaultRefAlias,
	isReservedPackageFilesKodyId,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { resolveCachedArtifactSourceHead } from '#worker/repo/artifact-head-cache.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
/**
 * The canonical path for a listing, or null when the owner/`kody.id` pair does
 * not lead back to it. The owner half comes from the listing's scoped name,
 * which a failed republish can leave stale, so a caller redirecting permanently
 * has to know the destination actually resolves — a cached redirect to a 404
 * would outlive the data fix.
 */
export async function resolveCanonicalListingPath(input: {
	env: Env
	listingId: string
	ownerUsername: string
	kodyId: string
}): Promise<string | null> {
	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})
	if (target?.listingId !== input.listingId) return null
	return getCommunityPackageHref(target)
}

export type CommunityFilesRouteTarget =
	| Extract<
			import('./package-page.ts').PackagePageAccess,
			{ kind: 'no_access' }
	  >
	| {
			kind: 'listing'
			listingId: string
			selectedPath: string
			ref: string
			/** Set when the URL already names the package (`/@user/kody/tree/…`). */
			packagePath?: { username: string; kodyId: string }
	  }
	| {
			kind: 'package'
			username: string
			kodyId: string
			selectedPath: string
			ref: string
	  }
	| { kind: 'redirect'; to: string; shared: boolean }
	| { kind: 'unauthorized' }
	| { kind: 'invalid-path' }

function filesPathRedirect(
	to: string,
	shared: boolean,
): CommunityFilesRouteTarget {
	return { kind: 'redirect', to, shared }
}

function selectedPathFromParams(relativePath: string | undefined) {
	return normalizePackageFilesPath(relativePath ?? '')
}

function requestedTreeRef(ref: string | undefined) {
	return ref?.trim() ?? ''
}

async function resolveSourceDefaultTreeRef(
	env: Env,
	sourceId: string | null,
	request?: Request,
) {
	if (!sourceId) return fallbackDefaultBranchName
	try {
		const source = await getEntitySourceById(env.APP_DB, sourceId)
		if (!source?.repo_id) return fallbackDefaultBranchName
		const head = await resolveCachedArtifactSourceHead(env, source.repo_id, {
			request,
		})
		const branch = head.branch?.trim()
		return branch || fallbackDefaultBranchName
	} catch {
		return fallbackDefaultBranchName
	}
}

async function resolveListingDefaultTreeRef(
	env: Env,
	listingId: string,
	request?: Request,
) {
	try {
		const listing = await getCommunityListingById(env.APP_DB, {
			listingId,
			includeDelisted: false,
		})
		return resolveSourceDefaultTreeRef(env, listing?.sourceId ?? null, request)
	} catch {
		return fallbackDefaultBranchName
	}
}

export function treeHrefFromPackageHome(
	packageHref: string,
	input: { ref?: string; relativePath?: string },
) {
	// This is a canonical business redirect, not a website route classifier.
	try {
		const pathname = new URL(
			packageHref,
			'https://kody.local',
		).pathname.replace(/\/$/, '')
		const parts = pathname.split('/').slice(1)
		if (
			parts.length !== 2 ||
			!parts[0]?.startsWith('@') ||
			parts[0].length < 2 ||
			!parts[1]
		)
			return packageHref
		return getPackageTreeHref({
			username: decodeURIComponent(parts[0].slice(1)),
			kodyId: decodeURIComponent(parts[1]),
			ref: input.ref,
			relativePath: input.relativePath,
		})
	} catch {
		return packageHref
	}
}

async function resolveOwnerPackageFilesTarget(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	selectedPath: string
	ref: string | undefined
	pathname: string
}): Promise<CommunityFilesRouteTarget | null> {
	const page = await loadPackagePage({
		env: input.env,
		request: input.request,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (page.kind === 'not_found') return null
	// Files stay closed for no-access the same as unauthorized; the package
	// home page already explains how to request a grant.
	if (page.kind === 'no_access') return page
	if (page.kind === 'unauthorized') {
		return { kind: 'unauthorized' }
	}
	const requestedRef = requestedTreeRef(input.ref)
	if (page.kind === 'redirect') {
		const ref = isPublicTreeDefaultRefAlias(requestedRef)
			? fallbackDefaultBranchName
			: requestedRef
		return filesPathRedirect(
			treeHrefFromPackageHome(page.to, {
				ref,
				relativePath: input.selectedPath,
			}),
			page.shared,
		)
	}
	const listingSourceId = page.listing?.listing
		? (
				await getCommunityListingById(input.env.APP_DB, {
					listingId: page.listing.listing.id,
					includeDelisted: false,
				})
			)?.sourceId
		: null
	const ref = isPublicTreeDefaultRefAlias(requestedRef)
		? await resolveSourceDefaultTreeRef(
				input.env,
				page.ownerPackage?.sourceId ?? listingSourceId ?? null,
				input.request,
			)
		: requestedRef
	const canonicalPath = getPackageTreeHref({
		username: page.username,
		kodyId: page.kodyId,
		listingId: page.listing?.listing?.id ?? null,
		relativePath: input.selectedPath,
		ref,
	})
	if (canonicalPath !== input.pathname) {
		// This URL did not resolve as a public listing, so leftover `/files`
		// and default-ref hops stay owner-private even when a listing exists
		// under a different unpublished pair.
		return filesPathRedirect(canonicalPath, false)
	}
	return {
		kind: 'package',
		username: page.username,
		kodyId: page.kodyId,
		selectedPath: input.selectedPath,
		ref,
	}
}

async function canonicalPublicTreeRef(input: {
	env: Env
	request?: Request
	listingId: string
	ref: string | undefined
}) {
	if (!isPublicTreeDefaultRefAlias(input.ref)) {
		return requestedTreeRef(input.ref)
	}
	return resolveListingDefaultTreeRef(input.env, input.listingId, input.request)
}

export type PackageFilesResource =
	| { kind: 'listing-files'; listingId: string; relativePath: string }
	| {
			kind: 'package-files'
			username: string
			kodyId: string
			relativePath: string
	  }
	| {
			kind: 'package-tree'
			username: string
			kodyId: string
			ref: string
			relativePath: string
	  }

export async function resolveCommunityFilesRoute(input: {
	env: Env
	resource: PackageFilesResource
	pathname: string
	queryRef?: string
	request?: Request
}): Promise<CommunityFilesRouteTarget | null> {
	const parsed = input.resource
	const detailMatch = parsed?.kind === 'listing-files' ? parsed : null
	if (detailMatch) {
		const selectedPath = selectedPathFromParams(detailMatch.relativePath)
		if (selectedPath == null) return { kind: 'invalid-path' }
		const ref = await canonicalPublicTreeRef({
			env: input.env,
			request: input.request,
			listingId: detailMatch.listingId,
			ref: input.queryRef ?? '',
		})
		return {
			kind: 'listing',
			listingId: detailMatch.listingId,
			selectedPath,
			ref,
		}
	}

	const leftoverFilesMatch = parsed?.kind === 'package-files' ? parsed : null
	if (leftoverFilesMatch) {
		const selectedPath = selectedPathFromParams(leftoverFilesMatch.relativePath)
		if (selectedPath == null) return { kind: 'invalid-path' }
		if (isReservedPackageFilesKodyId(leftoverFilesMatch.kodyId)) {
			return { kind: 'invalid-path' }
		}
		const target = await resolveCommunityPackageUrl({
			db: input.env.APP_DB,
			username: leftoverFilesMatch.username,
			kodyId: leftoverFilesMatch.kodyId,
		})
		if (target) {
			const ref = await canonicalPublicTreeRef({
				env: input.env,
				request: input.request,
				listingId: target.listingId,
				ref: input.queryRef ?? '',
			})
			return filesPathRedirect(
				getCommunityPackageFilesHref({
					listingId: target.listingId,
					ownerUsername: target.username,
					kodyId: target.kodyId,
					relativePath: selectedPath,
					ref,
				}),
				true,
			)
		}
		if (!input.request) return null
		return resolveOwnerPackageFilesTarget({
			env: input.env,
			request: input.request,
			username: leftoverFilesMatch.username,
			kodyId: leftoverFilesMatch.kodyId,
			selectedPath,
			ref: input.queryRef ?? '',
			pathname: input.pathname,
		})
	}

	const treeMatch = parsed?.kind === 'package-tree' ? parsed : null
	if (!treeMatch) return null

	const selectedPath = selectedPathFromParams(treeMatch.relativePath)
	if (selectedPath == null) return { kind: 'invalid-path' }

	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: treeMatch.username,
		kodyId: treeMatch.kodyId,
	})
	if (target) {
		const ref = await canonicalPublicTreeRef({
			env: input.env,
			request: input.request,
			listingId: target.listingId,
			ref: treeMatch.ref,
		})
		const canonicalPath = getCommunityPackageFilesHref({
			listingId: target.listingId,
			ownerUsername: target.username,
			kodyId: target.kodyId,
			relativePath: selectedPath,
			ref,
		})
		if (target.kind === 'redirect' || canonicalPath !== input.pathname) {
			return filesPathRedirect(canonicalPath, true)
		}
		return {
			kind: 'listing',
			listingId: target.listingId,
			selectedPath,
			ref,
			packagePath: { username: target.username, kodyId: target.kodyId },
		}
	}

	if (!input.request) return null
	return resolveOwnerPackageFilesTarget({
		env: input.env,
		request: input.request,
		username: treeMatch.username,
		kodyId: treeMatch.kodyId,
		selectedPath,
		ref: treeMatch.ref,
		pathname: input.pathname,
	})
}

export async function resolveCanonicalFilesPath(input: {
	env: Env
	listingId: string
	ownerUsername: string
	kodyId: string
	selectedPath: string
	ref?: string
}): Promise<string | null> {
	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})
	if (target?.listingId !== input.listingId) return null
	return getCommunityPackageFilesHref({
		listingId: input.listingId,
		ownerUsername: target.username,
		kodyId: target.kodyId,
		relativePath: input.selectedPath,
		ref: input.ref,
	})
}
