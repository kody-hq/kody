import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { getOwnerUsernameFromListingName } from '#worker/community/public-urls.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import { readCommunitySnapshot } from '#worker/community/snapshot.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import {
	buildCommunityIconUrl,
	resolvePackageListIconUrl,
} from '#universal/identity-icon-urls.ts'
import {
	isPackageFilesMediaKind,
	maxPackageFilePreviewBytes,
	resolvePackageFileRawType,
	safeContentDispositionFilename,
	snapshotStringToBytes,
	type PackageFileRawType,
} from '#universal/package-file-media.ts'
import {
	buildPackageFilesView,
	fallbackDefaultBranchName,
	findDirectoryReadmePath,
	getCommunityPackageFilesHref,
	getCommunityPackageRawHref,
	getPackageRawHref,
	getPackageTreeHref,
	isPublicTreeDefaultRefAlias,
	normalizePackageFilesPath,
	type PackageFilesView,
} from '#universal/package-files.ts'
import {
	readArtifactFileAtCommit,
	readArtifactTreeAtCommit,
} from '#worker/repo/artifact-file.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	highlightMarkdownFences,
	highlightSnippets,
} from '#app/highlight-code.ts'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { resolveCachedArtifactSourceHead } from '#worker/repo/artifact-head-cache.ts'
import { readArtifactSourceSnapshot } from '#worker/repo/artifact-source-snapshot.ts'
import { recordServerTiming } from '#worker/request-context.ts'
import {
	getEntitySourceByEntity,
	getEntitySourceById,
} from '#worker/repo/entity-sources.ts'
import { findRootPackageDoc } from '#worker/repo/required-package-docs.ts'
import { buildPackageRepoActionsForPage } from '#app/package-repo-actions.ts'
import {
	getCommunityPackageAssetBaseHref,
	getCommunityPackageAssetBaseHrefForViewedCommit,
} from '#universal/package-readme-images.ts'

export function readPackageFilesSelectedPath(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	return normalizePackageFilesPath(url.searchParams.get('path'))
}

async function toLoaderData(input: {
	env: Env
	title: string
	backHref: string
	backLabel: string
	filesBasePath: string
	view: PackageFilesView
	serverTiming?: Array<ServerTimingEntry>
	username?: string
	kodyId?: string
	viewerIsOwner?: boolean
	viewerCanManage?: boolean
	isPrivate?: boolean
	isListed?: boolean
	/** False for plain repos that share package chrome. Defaults to true. */
	hasPackage?: boolean
	listingId?: string | null
	iconUrl?: string | null
	viewedCommit?: string | null
	assetCommit?: string | null
	rawHref?: string | null
	description?: string
	ownerProfilePublic?: boolean
}): Promise<PackageFilesLoaderData> {
	const contentKind = input.view.contentKind
	const omitText =
		isPackageFilesMediaKind(contentKind) || contentKind === 'binary'
	const content = omitText ? null : input.view.content
	const language = omitText ? null : input.view.language
	const highlightOptions = { serverTiming: input.serverTiming }
	const contentFences =
		contentKind === 'markdown' && content
			? await highlightMarkdownFences(input.env, content, highlightOptions)
			: []
	const contentHighlighted =
		contentKind === 'code' && content
			? ((
					await highlightSnippets(
						input.env,
						[{ code: content, lang: language ?? 'plaintext' }],
						highlightOptions,
					)
				)[0] ?? plainHighlightedCode(content, language))
			: content
				? plainHighlightedCode(content, language)
				: null
	return {
		ok: true,
		title: input.title,
		backHref: input.backHref,
		backLabel: input.backLabel,
		filesBasePath: input.filesBasePath,
		selectedPath: input.view.selectedPath,
		kind: input.view.kind,
		paths: input.view.paths,
		children: input.view.children,
		content,
		contentPath: input.view.contentPath,
		contentKind,
		language,
		contentByteLength: input.view.contentByteLength,
		mediaHref: isPackageFilesMediaKind(contentKind)
			? (input.rawHref ?? null)
			: null,
		// `/raw/` buffers the whole blob, so it shares the preview size cap.
		rawHref:
			input.view.kind === 'file' &&
			(input.view.contentByteLength ?? 0) <= maxPackageFilePreviewBytes
				? (input.rawHref ?? null)
				: null,
		contentFences,
		contentHighlighted,
		username: input.username,
		kodyId: input.kodyId,
		viewerIsOwner: input.viewerIsOwner,
		viewerCanManage: input.viewerCanManage,
		isPrivate: input.isPrivate,
		isListed: input.isListed ?? Boolean(input.listingId),
		hasPackage: input.hasPackage,
		iconUrl: input.iconUrl ?? null,
		imageBaseHref: getCommunityPackageAssetBaseHrefForViewedCommit({
			listingId: input.listingId,
			ownerUsername: input.username,
			kodyId: input.kodyId,
			viewedCommit: input.viewedCommit,
			assetCommit: input.assetCommit,
		}),
		description: input.description,
		ownerProfilePublic: input.ownerProfilePublic,
	}
}

async function readOptionalViewerPersonalOrgId(input: {
	env: Env
	request: Request
}) {
	try {
		const user = await readAuthenticatedAppUser(input.request, input.env)
		if (!user) return null
		return personalOrgIdForPerson(user.mcpUser)
	} catch (error) {
		console.error(
			'Failed to resolve authenticated viewer for package files:',
			error,
		)
		return null
	}
}

export async function loadCommunityPackageFilesData(input: {
	env: Env
	request: Request
	listingId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) return null

	const ownerUsername = getOwnerUsernameFromListingName(listing.name)
	const treeRef = input.ref?.trim() ?? ''
	const [tree, viewerPersonalOrgId, ownerRow] = await Promise.all([
		loadCommunityListingPublicTree({
			env: input.env,
			request: input.request,
			listing,
			treeRef,
		}),
		readOptionalViewerPersonalOrgId({
			env: input.env,
			request: input.request,
		}),
		ownerUsername
			? getUserSocialRowByUsername(input.env.APP_DB, ownerUsername)
			: Promise.resolve(null),
	])
	if (!tree) return null
	const { loaded, urlRef, resolved } = tree
	const files = loaded.files
	const filesBasePath = getCommunityPackageFilesHref({
		listingId: listing.id,
		ownerUsername,
		kodyId: listing.kodyId,
		ref: urlRef,
	})
	const view = buildPackageFilesView({
		files,
		selectedPath: input.selectedPath,
	})
	if (!view) return null
	const viewerOwnsListing =
		viewerPersonalOrgId != null && viewerPersonalOrgId === listing.ownerUserId

	return toLoaderData({
		env: input.env,
		title: listing.name,
		backHref: getCommunityListingHref({
			listingId: listing.id,
			ownerUsername,
			kodyId: listing.kodyId,
		}),
		backLabel: 'Repo',
		filesBasePath,
		view,
		serverTiming: input.serverTiming,
		username: ownerUsername ?? undefined,
		kodyId: listing.kodyId,
		viewerIsOwner: viewerOwnsListing,
		viewerCanManage: viewerOwnsListing,
		isPrivate: false,
		listingId: listing.id,
		iconUrl: buildCommunityIconUrl({
			listingId: listing.id,
			iconCommit: listing.iconCommit,
		}),
		viewedCommit: resolved.commit,
		assetCommit: listing.pinnedCommit,
		rawHref: view.contentPath
			? getCommunityPackageRawHref({
					listingId: listing.id,
					ownerUsername,
					kodyId: listing.kodyId,
					ref: urlRef,
					relativePath: view.contentPath,
				})
			: null,
		description: listing.description,
		ownerProfilePublic: ownerRow?.profile_visibility === 'public',
	})
}

async function resolvePublicTreeCommit(input: {
	env: Env
	request: Request
	sourceRepoId: string | null
	publishedCommit: string | null
	pinnedCommit: string
	ref: string
}): Promise<{ commit: string | null; defaultBranch: string }> {
	const ref = input.ref.trim()
	let headCommit: string | null = null
	let defaultBranch = fallbackDefaultBranchName
	if (input.sourceRepoId) {
		try {
			const head = await resolveCachedArtifactSourceHead(
				input.env,
				input.sourceRepoId,
				{ request: input.request },
			)
			headCommit = head.commit
			defaultBranch = head.branch?.trim() || fallbackDefaultBranchName
		} catch {
			headCommit = input.publishedCommit
		}
	}
	if (isPublicTreeDefaultRefAlias(ref) || ref === defaultBranch) {
		return {
			commit: headCommit ?? input.publishedCommit ?? input.pinnedCommit,
			defaultBranch,
		}
	}
	if (headCommit && (headCommit === ref || headCommit.startsWith(ref))) {
		return { commit: headCommit, defaultBranch }
	}
	if (
		input.publishedCommit &&
		(input.publishedCommit === ref || input.publishedCommit.startsWith(ref))
	) {
		return { commit: input.publishedCommit, defaultBranch }
	}
	if (input.pinnedCommit === ref || input.pinnedCommit.startsWith(ref)) {
		return { commit: input.pinnedCommit, defaultBranch }
	}
	if (/^[0-9a-f]{7,40}$/i.test(ref)) {
		return { commit: ref, defaultBranch }
	}
	return {
		commit: headCommit ?? input.publishedCommit ?? input.pinnedCommit,
		defaultBranch,
	}
}

export function loadPublicTreeFiles(input: {
	env: Env
	request: Request
	listingId?: string | null
	sourceId: string
	sourceRepoId: string | null
	commit: string | null
	pinnedCommit: string
}) {
	return recordServerTiming(
		'files',
		() => loadPublicTreeFilesUncached(input),
		input.request,
	)
}

async function loadPublicTreeFilesUncached(input: {
	env: Env
	listingId?: string | null
	sourceId: string
	sourceRepoId: string | null
	commit: string | null
	pinnedCommit: string
}): Promise<{
	files: Record<string, string>
	fromListingSnapshot: boolean
}> {
	const commit = input.commit
	if (commit && input.env.BUNDLE_ARTIFACTS_KV) {
		try {
			const snapshot = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: input.sourceId,
				publishedCommit: commit,
			})
			if (snapshot?.files) {
				return { files: snapshot.files, fromListingSnapshot: false }
			}
		} catch {
			// Fall through to git / listing snapshot.
		}
	}
	if (input.sourceRepoId && commit) {
		try {
			const treeSnapshot = await readArtifactSourceSnapshot({
				env: input.env,
				repoId: input.sourceRepoId,
				commit,
			})
			if (treeSnapshot?.files) {
				return { files: treeSnapshot.files, fromListingSnapshot: false }
			}
		} catch {
			// Fall through to the listing pin snapshot.
		}
	}
	if (input.listingId && input.env.BUNDLE_ARTIFACTS_KV) {
		const listingSnapshot = await readCommunitySnapshot(
			input.env.BUNDLE_ARTIFACTS_KV,
			input.listingId,
		)
		if (listingSnapshot?.files) {
			return { files: listingSnapshot.files, fromListingSnapshot: true }
		}
	}
	return { files: {}, fromListingSnapshot: Boolean(input.listingId) }
}

function listingSnapshotMissesRequestedHex(input: {
	treeRef: string
	fromListingSnapshot: boolean
	resolvedCommit: string | null
	pinnedCommit: string
}) {
	if (!/^[0-9a-f]{7,40}$/i.test(input.treeRef)) return false
	if (!input.fromListingSnapshot) return false
	if (input.resolvedCommit === input.pinnedCommit) return false
	return !(
		input.pinnedCommit.startsWith(input.treeRef) ||
		input.treeRef.startsWith(input.pinnedCommit)
	)
}

async function loadCommunityListingPublicTree(input: {
	env: Env
	request: Request
	listing: {
		id: string
		sourceId: string
		pinnedCommit: string
	}
	treeRef: string
}) {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.listing.sourceId,
	)
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source?.repo_id ?? null,
		publishedCommit: source?.published_commit ?? input.listing.pinnedCommit,
		pinnedCommit: input.listing.pinnedCommit,
		ref: input.treeRef,
	})
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		listingId: input.listing.id,
		sourceId: input.listing.sourceId,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolved.commit,
		pinnedCommit: input.listing.pinnedCommit,
	})
	if (
		listingSnapshotMissesRequestedHex({
			treeRef: input.treeRef,
			fromListingSnapshot: loaded.fromListingSnapshot,
			resolvedCommit: resolved.commit,
			pinnedCommit: input.listing.pinnedCommit,
		})
	) {
		return null
	}
	const urlRef = isPublicTreeDefaultRefAlias(input.treeRef)
		? resolved.defaultBranch
		: input.treeRef
	return { source, resolved, loaded, urlRef }
}

export async function loadAccountPackageFilesData(input: {
	env: Env
	request: Request
	userId: string
	username: string
	packageId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
	isListed?: boolean
}): Promise<PackageFilesLoaderData | null> {
	const record = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!record) return null

	const [source, ownerRow] = await Promise.all([
		getEntitySourceById(input.env.APP_DB, record.sourceId),
		getUserSocialRowByUsername(input.env.APP_DB, input.username),
	])
	const treeRef = input.ref?.trim() ?? ''
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source?.repo_id ?? null,
		publishedCommit: source?.published_commit ?? '',
		pinnedCommit: source?.published_commit ?? '',
		ref: treeRef,
	})
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		sourceId: record.sourceId,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolved.commit,
		pinnedCommit: source?.published_commit ?? '',
	})
	let files = loaded.files
	if (Object.keys(files).length === 0) {
		try {
			const packageSource = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: getAppBaseUrl({
					env: input.env,
					requestUrl: input.request.url,
				}),
				userId: input.userId,
				sourceId: record.sourceId,
			})
			files = packageSource.files
		} catch {
			files = {}
		}
	}

	const view = buildPackageFilesView({
		files,
		selectedPath: input.selectedPath,
	})
	if (!view) return null

	const urlRef = isPublicTreeDefaultRefAlias(treeRef)
		? resolved.defaultBranch
		: treeRef || resolved.defaultBranch
	return toLoaderData({
		env: input.env,
		title: record.name,
		backHref: routes.communityPackage.href({
			username: input.username,
			kodyId: record.kodyId,
		}),
		backLabel: 'Repo',
		filesBasePath: getPackageTreeHref({
			username: input.username,
			kodyId: record.kodyId,
			ref: urlRef,
		}),
		view,
		serverTiming: input.serverTiming,
		username: input.username,
		kodyId: record.kodyId,
		viewerIsOwner: true,
		viewerCanManage: true,
		isPrivate: record.isPrivate,
		isListed: input.isListed === true,
		iconUrl: resolvePackageListIconUrl({
			username: input.username,
			kodyId: record.kodyId,
			listingId: null,
			listingIconCommit: null,
			publishedCommit: source?.published_commit ?? null,
		}),
		viewedCommit: resolved.commit,
		assetCommit: source?.published_commit ?? '',
		rawHref: view.contentPath
			? getPackageRawHref({
					username: input.username,
					kodyId: record.kodyId,
					ref: urlRef,
					relativePath: view.contentPath,
				})
			: null,
		description: record.description,
		ownerProfilePublic: ownerRow?.profile_visibility === 'public',
	})
}

/**
 * Plain repos are live at HEAD via entity_sources.repo_id. Access is gated by
 * loadPackagePage (public guests; private members/owners) before this runs.
 */
export async function loadPlainRepoFilesData(input: {
	env: Env
	request: Request
	ownerUserId: string
	username: string
	kodyId: string
	repoId: string
	sourceId: string
	isPrivate: boolean
	description: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
	viewerIsOwner?: boolean
	viewerCanManage?: boolean
	ownerProfilePublic?: boolean
}): Promise<PackageFilesLoaderData | null> {
	const source = input.sourceId
		? await getEntitySourceById(input.env.APP_DB, input.sourceId)
		: await getEntitySourceByEntity(input.env.APP_DB, {
				userId: ownerIdFromStored(input.ownerUserId),
				entityKind: 'repo',
				entityId: input.repoId,
			})
	if (!source?.repo_id) return null

	const liveCommit = source.indexed_commit ?? source.published_commit ?? ''
	const treeRef = input.ref?.trim() ?? ''
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source.repo_id,
		publishedCommit: source.published_commit ?? liveCommit,
		pinnedCommit: liveCommit,
		ref: treeRef,
	})
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		sourceId: source.id,
		sourceRepoId: source.repo_id,
		commit: resolved.commit,
		pinnedCommit: liveCommit,
	})
	// Plain repos are live-at-HEAD and usually have no publish KV snapshot.
	// When the public tree path is empty, shallow-fetch the Artifacts commit.
	let files = loaded.files
	if (Object.keys(files).length === 0 && resolved.commit) {
		try {
			const tree = await readArtifactTreeAtCommit({
				env: input.env,
				repoId: source.repo_id,
				commit: resolved.commit,
			})
			if (tree) files = tree
		} catch {
			files = {}
		}
	}
	const view = buildPackageFilesView({
		files,
		selectedPath: input.selectedPath,
	})
	if (!view) return null

	const urlRef = isPublicTreeDefaultRefAlias(treeRef)
		? resolved.defaultBranch
		: treeRef || resolved.defaultBranch
	return toLoaderData({
		env: input.env,
		title: `@${input.username}/${input.kodyId}`,
		backHref: routes.communityPackage.href({
			username: input.username,
			kodyId: input.kodyId,
		}),
		backLabel: 'Repo',
		filesBasePath: getPackageTreeHref({
			username: input.username,
			kodyId: input.kodyId,
			ref: urlRef,
		}),
		view,
		serverTiming: input.serverTiming,
		username: input.username,
		kodyId: input.kodyId,
		viewerIsOwner: input.viewerIsOwner,
		viewerCanManage: input.viewerCanManage,
		isPrivate: input.isPrivate,
		isListed: false,
		hasPackage: false,
		// Identity icons only serve indexed/published commits (not live HEAD).
		iconUrl: resolvePackageListIconUrl({
			username: input.username,
			kodyId: input.kodyId,
			listingId: null,
			listingIconCommit: null,
			publishedCommit: source.indexed_commit ?? source.published_commit ?? null,
		}),
		viewedCommit: resolved.commit,
		// Plain repos have no package /assets/ publish snapshot; leave null so
		// README images are not rewritten to an unservable prefix.
		assetCommit: null,
		rawHref: view.contentPath
			? getPackageRawHref({
					username: input.username,
					kodyId: input.kodyId,
					ref: urlRef,
					relativePath: view.contentPath,
				})
			: null,
		description: input.description,
		ownerProfilePublic: input.ownerProfilePublic,
	})
}

export async function loadAccessiblePackageFilesData(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PackageFilesLoaderData | null> {
	const page = await loadPackagePage({
		env: input.env,
		request: input.request,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (page.kind !== 'page') return null

	if (page.listing?.listing) {
		const data = await loadCommunityPackageFilesData({
			env: input.env,
			request: input.request,
			listingId: page.listing.listing.id,
			selectedPath: input.selectedPath,
			ref: input.ref,
			serverTiming: input.serverTiming,
		})
		if (!data) return null
		return {
			...data,
			viewerIsOwner: page.viewerIsOwner,
			viewerCanManage: page.viewerCanManage,
			viewerCanManageAccess: page.viewerCanManageAccess,
			isPrivate: page.ownerPackage?.isPrivate ?? false,
			username: page.username,
			kodyId: page.kodyId,
			description: page.listing.listing.description,
			ownerProfilePublic: page.ownerProfilePublic,
			repoActions: await buildPackageRepoActionsForPage(
				page,
				input.env,
				input.request,
			),
		}
	}

	if (!page.ownerPackage) return null

	if (!page.hasPackage) {
		// loadPackagePage already gated access for public guests and private members.
		const data = await loadPlainRepoFilesData({
			env: input.env,
			request: input.request,
			ownerUserId: page.ownerUserId,
			username: page.username,
			kodyId: page.kodyId,
			repoId: page.ownerPackage.id,
			sourceId: page.ownerPackage.sourceId,
			isPrivate: page.ownerPackage.isPrivate,
			description: page.ownerPackage.description,
			selectedPath: input.selectedPath,
			ref: input.ref,
			serverTiming: input.serverTiming,
			viewerIsOwner: page.viewerIsOwner,
			viewerCanManage: page.viewerCanManage,
			ownerProfilePublic: page.ownerProfilePublic,
		})
		return data
			? {
					...data,
					repoActions: await buildPackageRepoActionsForPage(
						page,
						input.env,
						input.request,
					),
				}
			: null
	}

	if (!page.viewerIsOwner) return null
	const user = await readAuthenticatedAppUser(input.request, input.env)
	if (!user) return null
	const data = await loadAccountPackageFilesData({
		env: input.env,
		request: input.request,
		userId: page.ownerUserId,
		username: page.username,
		packageId: page.ownerPackage.id,
		selectedPath: input.selectedPath,
		ref: input.ref,
		serverTiming: input.serverTiming,
		isListed: page.ownerPackage.hasCommunityListing,
	})
	if (!data) return null
	return {
		...data,
		viewerCanManage: page.viewerCanManage,
		viewerCanManageAccess: page.viewerCanManageAccess,
		description: page.ownerPackage.description,
		ownerProfilePublic: page.ownerProfilePublic,
		repoActions: await buildPackageRepoActionsForPage(
			page,
			input.env,
			input.request,
		),
	}
}

/**
 * Files for a listing with the viewer's repo actions whenever the package page
 * resolves (the same payload as the canonical files API). Falls back to the
 * public listing tree, which carries no viewer actions.
 */
export async function loadListingFilesData(input: {
	env: Env
	request: Request
	listingId: string
	selectedPath: string
	ref?: string
	serverTiming?: Array<ServerTimingEntry>
	/** Skips the listing lookup when the URL already names the package. */
	packagePath?: { username: string; kodyId: string }
}): Promise<PackageFilesLoaderData | null> {
	const packagePath =
		input.packagePath ?? (await resolveListingPackagePath(input))
	if (packagePath) {
		const data = await loadAccessiblePackageFilesData({
			env: input.env,
			request: input.request,
			username: packagePath.username,
			kodyId: packagePath.kodyId,
			selectedPath: input.selectedPath,
			ref: input.ref,
			serverTiming: input.serverTiming,
		})
		if (data) return data
	}
	return loadCommunityPackageFilesData({
		env: input.env,
		request: input.request,
		listingId: input.listingId,
		selectedPath: input.selectedPath,
		ref: input.ref,
		serverTiming: input.serverTiming,
	})
}

async function resolveListingPackagePath(input: {
	env: Env
	listingId: string
}) {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	const username = listing
		? getOwnerUsernameFromListingName(listing.name)
		: null
	return listing && username ? { username, kodyId: listing.kodyId } : null
}

export async function loadPackagePageHasAgentsDocs(input: {
	env: Env
	request: Request
	listingId?: string | null
	ownerSourceId?: string | null
	viewerIsOwner: boolean
	ownerUserId?: string
}): Promise<boolean> {
	if (input.listingId && input.env.BUNDLE_ARTIFACTS_KV) {
		try {
			const snapshot = await readCommunitySnapshot(
				input.env.BUNDLE_ARTIFACTS_KV,
				input.listingId,
			)
			if (snapshot?.files) {
				return findRootPackageDoc(snapshot.files, 'AGENTS.md') != null
			}
		} catch {
			// Listing pages stay up when the snapshot read fails; hide the
			// Agent docs link instead of 404ing visitors on a dead tree URL.
		}
	}
	if (!input.viewerIsOwner || !input.ownerSourceId) return false
	const user = await readAuthenticatedAppUser(input.request, input.env)
	if (!user) return false
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: getAppBaseUrl({
				env: input.env,
				requestUrl: input.request.url,
			}),
			userId:
				input.ownerUserId ??
				ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
			sourceId: input.ownerSourceId,
		})
		return findRootPackageDoc(loaded.files, 'AGENTS.md') != null
	} catch {
		return false
	}
}

/**
 * README `<img>` opt-in. Listing README is the pin `/assets/` serves.
 * Owner fallback README is the published snapshot (`loadOwnerPackageReadme`),
 * or Artifacts HEAD for plain repos that have no publish KV snapshot.
 * Opt in only when that viewed README commit equals the blob `/assets/`
 * serves: listing pin when listed, otherwise published.
 */
export function resolvePackagePageReadmeImageBaseHref(input: {
	listingId?: string | null
	ownerUsername: string
	kodyId: string
	usedListingReadme: boolean
	/** Commit the README markdown was read from (published snapshot or live HEAD). */
	readmeCommit?: string | null
	publishedCommit?: string | null
	pinnedCommit?: string | null
}) {
	if (input.usedListingReadme) {
		return getCommunityPackageAssetBaseHref({
			listingId: input.listingId,
			ownerUsername: input.ownerUsername,
			kodyId: input.kodyId,
		})
	}
	const viewedReadmeCommit =
		input.readmeCommit?.trim() || input.publishedCommit?.trim() || ''
	// `/assets/` serves the listing pin or the published snapshot — never a
	// live HEAD tree. Do not fall back assetCommit to the viewed README
	// commit: that would opt in plain-repo HEAD readmes when no pin/publish
	// commit was passed.
	const assetCommit =
		input.pinnedCommit?.trim() || input.publishedCommit?.trim() || ''
	return getCommunityPackageAssetBaseHrefForViewedCommit({
		listingId: input.listingId,
		ownerUsername: input.ownerUsername,
		kodyId: input.kodyId,
		viewedCommit: viewedReadmeCommit,
		assetCommit,
	})
}

function readmeFromFiles(files: Record<string, string>): string | null {
	const path = findDirectoryReadmePath(files, '')
	if (!path) return null
	const content = files[path]?.trim()
	return content ? content : null
}

export type OwnerPackageReadme = {
	content: string | null
	/** Commit the README text was loaded from, when known. */
	commit: string | null
}

/**
 * Owner detail README. Prefer the published package snapshot; when that is
 * missing (plain repos have none), read the same Artifacts HEAD tree the
 * Files tab uses so detail and Files stay in parity.
 */
export async function loadOwnerPackageReadme(input: {
	env: Env
	request: Request
	userId: string
	sourceId: string
}): Promise<OwnerPackageReadme> {
	let source: Awaited<ReturnType<typeof getEntitySourceById>> = null
	try {
		source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	} catch {
		return { content: null, commit: null }
	}
	if (!source || source.user_id !== input.userId) {
		return { content: null, commit: null }
	}
	const publishedCommit = source.published_commit?.trim() || null
	if (publishedCommit) {
		try {
			const loaded = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: getAppBaseUrl({
					env: input.env,
					requestUrl: input.request.url,
				}),
				userId: input.userId,
				sourceId: input.sourceId,
			})
			const fromPublished = readmeFromFiles(loaded.files)
			return fromPublished
				? { content: fromPublished, commit: publishedCommit }
				: { content: null, commit: null }
		} catch {
			// Published snapshot unreadable — do not leak live HEAD to guests.
			return { content: null, commit: null }
		}
	}
	// Plain repos have no publish KV snapshot — Files already reads Artifacts HEAD.
	return loadOwnerPackageReadmeFromArtifactsHead({ ...input, source })
}

async function loadOwnerPackageReadmeFromArtifactsHead(input: {
	env: Env
	request: Request
	userId: string
	sourceId: string
	source: NonNullable<Awaited<ReturnType<typeof getEntitySourceById>>>
}): Promise<OwnerPackageReadme> {
	try {
		const { source } = input
		if (!source.repo_id || source.user_id !== input.userId) {
			return { content: null, commit: null }
		}
		const liveCommit = source.indexed_commit ?? source.published_commit ?? ''
		const resolved = await resolvePublicTreeCommit({
			env: input.env,
			request: input.request,
			sourceRepoId: source.repo_id,
			publishedCommit: source.published_commit ?? liveCommit,
			pinnedCommit: liveCommit,
			ref: '',
		})
		if (!resolved.commit) return { content: null, commit: null }
		const loaded = await loadPublicTreeFiles({
			env: input.env,
			request: input.request,
			sourceId: source.id,
			sourceRepoId: source.repo_id,
			commit: resolved.commit,
			pinnedCommit: liveCommit,
		})
		let files = loaded.files
		if (Object.keys(files).length === 0) {
			const tree = await readArtifactTreeAtCommit({
				env: input.env,
				repoId: source.repo_id,
				commit: resolved.commit,
			})
			if (tree) files = tree
		}
		return {
			content: readmeFromFiles(files),
			commit: resolved.commit,
		}
	} catch {
		return { content: null, commit: null }
	}
}

type PackageFileRawBytes = {
	kind: 'ok'
	bytes: Uint8Array
	filename: string
} & PackageFileRawType

export type PackageFileRawResult =
	| (PackageFileRawBytes & { isPrivate: boolean })
	| { kind: 'not-found' }
	| { kind: 'too-large' }

async function readPackageFileRawBytes(input: {
	env: Env
	files: Record<string, string>
	filePath: string
	sourceRepoId: string | null
	commit: string | null
}): Promise<
	PackageFileRawBytes | { kind: 'not-found' } | { kind: 'too-large' }
> {
	if (!Object.hasOwn(input.files, input.filePath)) {
		return { kind: 'not-found' }
	}
	let bytes: Uint8Array | null = null
	if (input.sourceRepoId && input.commit) {
		try {
			bytes = await readArtifactFileAtCommit({
				env: input.env,
				repoId: input.sourceRepoId,
				commit: input.commit,
				filePath: input.filePath,
			})
		} catch {
			bytes = null
		}
	}
	if (!bytes) {
		const snapshot = input.files[input.filePath]
		if (snapshot == null) return { kind: 'not-found' }
		bytes = snapshotStringToBytes(snapshot, input.filePath)
	}
	if (bytes.byteLength > maxPackageFilePreviewBytes) {
		return { kind: 'too-large' }
	}
	return {
		kind: 'ok',
		bytes,
		...resolvePackageFileRawType({ path: input.filePath, bytes }),
		filename: safeContentDispositionFilename(input.filePath),
	}
}

export async function loadCommunityPackageFileRaw(input: {
	env: Env
	request: Request
	listingId: string
	selectedPath: string
	ref?: string
}): Promise<PackageFileRawResult> {
	if (!input.selectedPath) return { kind: 'not-found' }
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) return { kind: 'not-found' }

	const treeRef = input.ref?.trim() ?? ''
	const tree = await loadCommunityListingPublicTree({
		env: input.env,
		request: input.request,
		listing,
		treeRef,
	})
	if (!tree) return { kind: 'not-found' }
	const { source, resolved, loaded } = tree
	const raw = await readPackageFileRawBytes({
		env: input.env,
		files: loaded.files,
		filePath: input.selectedPath,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolved.commit,
	})
	if (raw.kind !== 'ok') return raw
	return { ...raw, isPrivate: false }
}

export async function loadAccountPackageFileRaw(input: {
	env: Env
	request: Request
	userId: string
	username: string
	packageId: string
	selectedPath: string
	ref?: string
}): Promise<PackageFileRawResult> {
	if (!input.selectedPath) return { kind: 'not-found' }
	const record = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!record) return { kind: 'not-found' }

	const source = await getEntitySourceById(input.env.APP_DB, record.sourceId)
	const treeRef = input.ref?.trim() ?? ''
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source?.repo_id ?? null,
		publishedCommit: source?.published_commit ?? '',
		pinnedCommit: source?.published_commit ?? '',
		ref: treeRef,
	})
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		sourceId: record.sourceId,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolved.commit,
		pinnedCommit: source?.published_commit ?? '',
	})
	let files = loaded.files
	if (Object.keys(files).length === 0) {
		try {
			const packageSource = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: getAppBaseUrl({
					env: input.env,
					requestUrl: input.request.url,
				}),
				userId: input.userId,
				sourceId: record.sourceId,
			})
			files = packageSource.files
		} catch {
			files = {}
		}
	}
	const raw = await readPackageFileRawBytes({
		env: input.env,
		files,
		filePath: input.selectedPath,
		sourceRepoId: source?.repo_id ?? null,
		commit: resolved.commit,
	})
	if (raw.kind !== 'ok') return raw
	return { ...raw, isPrivate: record.isPrivate }
}

export async function loadPlainRepoFileRaw(input: {
	env: Env
	request: Request
	ownerUserId: string
	repoId: string
	sourceId: string
	isPrivate: boolean
	selectedPath: string
	ref?: string
}): Promise<PackageFileRawResult> {
	if (!input.selectedPath) return { kind: 'not-found' }
	const source = input.sourceId
		? await getEntitySourceById(input.env.APP_DB, input.sourceId)
		: await getEntitySourceByEntity(input.env.APP_DB, {
				userId: ownerIdFromStored(input.ownerUserId),
				entityKind: 'repo',
				entityId: input.repoId,
			})
	if (!source?.repo_id) return { kind: 'not-found' }

	const liveCommit = source.indexed_commit ?? source.published_commit ?? ''
	const treeRef = input.ref?.trim() ?? ''
	const resolved = await resolvePublicTreeCommit({
		env: input.env,
		request: input.request,
		sourceRepoId: source.repo_id,
		publishedCommit: source.published_commit ?? liveCommit,
		pinnedCommit: liveCommit,
		ref: treeRef,
	})
	const loaded = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		sourceId: source.id,
		sourceRepoId: source.repo_id,
		commit: resolved.commit,
		pinnedCommit: liveCommit,
	})
	let files = loaded.files
	if (Object.keys(files).length === 0 && resolved.commit) {
		try {
			const tree = await readArtifactTreeAtCommit({
				env: input.env,
				repoId: source.repo_id,
				commit: resolved.commit,
			})
			if (tree) files = tree
		} catch {
			files = {}
		}
	}
	const raw = await readPackageFileRawBytes({
		env: input.env,
		files,
		filePath: input.selectedPath,
		sourceRepoId: source.repo_id,
		commit: resolved.commit,
	})
	if (raw.kind !== 'ok') return raw
	return { ...raw, isPrivate: input.isPrivate }
}

export async function loadAccessiblePackageFileRaw(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	selectedPath: string
	ref?: string
	/** See `loadPackagePage`; omit to use the session cookie. */
	viewer?: McpUserContext | null
	/** Org an org-bound token is fixed to; other orgs read as anonymous. */
	viewerOrgId?: string | null
}): Promise<PackageFileRawResult> {
	const loadPage = (viewer: McpUserContext | null | undefined) =>
		loadPackagePage({
			env: input.env,
			request: input.request,
			username: input.username,
			kodyId: input.kodyId,
			viewer,
		})
	let page = await loadPage(input.viewer)
	if (
		input.viewer &&
		input.viewerOrgId &&
		page.kind === 'page' &&
		page.ownerUserId !== input.viewerOrgId
	) {
		page = await loadPage(null)
	}
	// Same gate as `loadAccessiblePackageFilesData`. Every denial, including
	// "sign in to see this unlisted package", is a 404 so raw URLs never
	// confirm a package exists.
	if (page.kind !== 'page') return { kind: 'not-found' }

	if (page.listing?.listing) {
		return loadCommunityPackageFileRaw({
			env: input.env,
			request: input.request,
			listingId: page.listing.listing.id,
			selectedPath: input.selectedPath,
			ref: input.ref,
		})
	}

	if (!page.ownerPackage) return { kind: 'not-found' }

	if (!page.hasPackage) {
		return loadPlainRepoFileRaw({
			env: input.env,
			request: input.request,
			ownerUserId: page.ownerUserId,
			repoId: page.ownerPackage.id,
			sourceId: page.ownerPackage.sourceId,
			isPrivate: page.ownerPackage.isPrivate,
			selectedPath: input.selectedPath,
			ref: input.ref,
		})
	}

	if (!page.viewerIsOwner) return { kind: 'not-found' }
	return loadAccountPackageFileRaw({
		env: input.env,
		request: input.request,
		userId: page.ownerUserId,
		username: page.username,
		packageId: page.ownerPackage.id,
		selectedPath: input.selectedPath,
		ref: input.ref,
	})
}
