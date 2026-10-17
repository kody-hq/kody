import {
	buildPackageRepoActions,
	buildPackageRepoActionsForPage,
} from '#app/package-repo-actions.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import {
	loadPackagePage,
	ownerPackageForClient,
	packagePageIsPrivate,
} from '#app/package-page.ts'
import {
	loadOwnerPackageReadme,
	loadPackagePageHasAgentsDocs,
	resolvePackagePageReadmeImageBaseHref,
} from '#app/package-files-data.ts'
import { highlightMarkdownFences } from '#app/highlight-code.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { recordServerTiming } from '#worker/request-context.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
export async function highlightReadmeFences(
	env: Env,
	readmeContent: string | null,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<Array<HighlightedCode>> {
	if (!readmeContent) return []
	return highlightMarkdownFences(env, readmeContent, { serverTiming })
}

export async function readmeForPackagePage(
	input: {
		env: Env
		request: Request
		listingReadme: string | null | undefined
		ownerSourceId: string | null | undefined
		viewerIsOwner: boolean
		isPrivate: boolean
		ownerUserId?: string
	},
	serverTiming?: Array<ServerTimingEntry>,
) {
	let readmeContent = input.listingReadme ?? null
	let readmeCommit: string | null = null
	const ownerSourceId = input.ownerSourceId
	const ownerUserId = input.ownerUserId
	if (
		!readmeContent &&
		ownerSourceId &&
		ownerUserId &&
		(input.viewerIsOwner || !input.isPrivate)
	) {
		const loaded = await recordServerTiming(
			'owner-readme',
			() =>
				loadOwnerPackageReadme({
					env: input.env,
					request: input.request,
					userId: ownerUserId,
					sourceId: ownerSourceId,
				}),
			input.request,
		)
		readmeContent = loaded.content
		readmeCommit = loaded.commit
	}
	return {
		readmeContent,
		readmeCommit,
		readmeFences: await highlightReadmeFences(
			input.env,
			readmeContent,
			serverTiming,
		),
	}
}

export async function loadCommunityDetailPayload(
	env: Env,
	request: Request,
	listingId: string,
	detail = undefined as
		| Awaited<ReturnType<typeof loadCommunityDetailData>>
		| undefined,
) {
	detail ??= await loadCommunityDetailData(env, request, listingId)
	if (!detail?.listing) return { kind: 'not_found' as const }
	const serverTiming: Array<ServerTimingEntry> = []
	const [readmeFences, hasAgentsDocs, imageBaseHref] = await Promise.all([
		highlightReadmeFences(env, detail.listing.readmeContent, serverTiming),
		recordServerTiming(
			'agents-docs',
			() =>
				loadPackagePageHasAgentsDocs({
					env,
					request,
					listingId,
					ownerSourceId: detail.ownerPackage?.sourceId,
					viewerIsOwner: detail.viewerIsOwner,
				}),
			request,
		),
		resolvePackagePageReadmeImageBaseHref({
			listingId,
			ownerUsername: detail.username,
			kodyId: detail.listing.kodyId,
			usedListingReadme: true,
		}),
	])
	return {
		kind: 'page' as const,
		serverTiming,
		data: {
			...detail,
			repoActions: buildPackageRepoActions({
				...detail,
				kodyId: detail.listing.kodyId,
			}),
			hasPackage: true,
			packageShaped: false,
			readmeContent: detail.listing.readmeContent,
			kodyId: detail.listing.kodyId,
			isPrivate: false,
			readmeFences,
			hasAgentsDocs,
			imageBaseHref,
		},
	}
}
export async function loadCommunityPackagePayload(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
}) {
	const { env, request } = input
	const page = await loadPackagePage(input)
	if (page.kind !== 'page') return page
	const serverTiming: Array<ServerTimingEntry> = []
	const [readme, hasAgentsDocs] = await Promise.all([
		readmeForPackagePage(
			{
				env,
				request,
				listingReadme: page.listing?.listing?.readmeContent,
				ownerSourceId: page.ownerPackage?.sourceId,
				viewerIsOwner: page.viewerIsOwner,
				ownerUserId: page.ownerUserId,
				isPrivate: packagePageIsPrivate(page),
			},
			serverTiming,
		),
		recordServerTiming(
			'agents-docs',
			() =>
				loadPackagePageHasAgentsDocs({
					env,
					request,
					listingId: page.listing?.listing?.id,
					ownerSourceId: page.ownerPackage?.sourceId,
					viewerIsOwner: page.viewerIsOwner,
					ownerUserId: page.ownerUserId,
				}),
			request,
		),
	])
	const imageBaseHref = resolvePackagePageReadmeImageBaseHref({
		listingId: page.listing?.listing?.id,
		ownerUsername: page.username,
		kodyId: page.kodyId,
		usedListingReadme: Boolean(page.listing?.listing?.readmeContent),
		readmeCommit: readme.readmeCommit,
		publishedCommit: page.ownerPackage?.publishedCommit,
		pinnedCommit: page.listing?.listing?.pinnedCommit,
	})
	return {
		kind: 'page' as const,
		serverTiming,
		data: {
			ok: true as const,
			listing: page.listing?.listing ?? null,
			ownerProfilePublic: page.ownerProfilePublic,
			viewerIsOwner: page.viewerIsOwner,
			viewerCanManage: page.viewerCanManage,
			viewerCanManageAccess: page.viewerCanManageAccess,
			repoActions: buildPackageRepoActionsForPage(page),
			viewerCanPublish: page.viewerCanPublish,
			viewerCanDelete: page.viewerCanDelete,
			viewerCanAdoptCommunityFork: page.viewerCanAdoptCommunityFork,
			loggedIn: page.loggedIn,
			viewerIsAdmin: page.listing?.viewerIsAdmin ?? false,
			forkPrompt: page.listing?.forkPrompt ?? '',
			viewerInstall: page.listing?.viewerInstall ?? null,
			readmeContent: readme.readmeContent,
			readmeFences: readme.readmeFences,
			hasAgentsDocs,
			imageBaseHref,
			ownerPackage: ownerPackageForClient(page),
			hasPackage: page.hasPackage,
			packageShaped: page.packageShaped === true,
			username: page.username,
			kodyId: page.kodyId,
			isPrivate: packagePageIsPrivate(page),
			invocationUrlOrigin: page.invocationUrlOrigin,
		},
	}
}
