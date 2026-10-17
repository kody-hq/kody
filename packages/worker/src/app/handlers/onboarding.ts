import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	deriveOnboardingChecklist,
	loadOnboardingAccessWin,
	loadOnboardingAccessWinMemorySubject,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'
import { hasSecondConnectedMcpClient } from '#universal/onboarding-agent-ecosystems.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import { type OAuthGrantListHelpers } from '#worker/oauth-grants.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadOnboardingFeaturedListings,
	loadOnboardingMcpChooserListings,
} from '#app/community-data.ts'
import {
	loadMcpClientHubReadSnapshotOrNull,
	mcpServerStatusError,
} from '#mcp/capabilities/mcp-servers/shared.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import {
	attachOnboardingMcpPackageListings,
	firstConnectedOnboardingWorkspaceLabel,
	listDisconnectedOnboardingFeaturedMcpServers,
	listOnboardingCustomMcpServers,
	overlayOnboardingFeaturedMcpServers,
} from '#universal/onboarding-mcp-chooser.ts'
import { firstInstalledOnboardingExampleName } from '#universal/onboarding-examples.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
	type OnboardingLoaderData,
} from '#universal/loader-data.ts'
import {
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'
import { anonymousPersonalizedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import {
	loadPlatformIntegrationCatalog,
	onboardingFeaturedPlatformIntegrationSlugs,
} from '#app/platform-integration-catalog.ts'
import {
	onboardingIndexRedirectHref,
	type OnboardingWizardProgress,
} from '#universal/onboarding-process.ts'
import {
	highlightResultsByKey,
	highlightSnippets,
} from '#app/highlight-code.ts'
import { collectOnboardingMcpSnippets } from '#universal/onboarding-mcp-clients.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

/**
 * The checklist derives from existing signals (MCP grants, integrations,
 * saved packages), so it only computes for verified users — unverified
 * accounts have nothing to derive and should not pay the probes.
 */
export async function loadChecklist(
	env: Env,
	userId: OwnerId,
	personId: OwnerId,
	username: string,
	hasMcpClient: boolean,
	options?: { hasAccessWin?: boolean; hasSecondMcpClient?: boolean },
): Promise<OnboardingChecklistLoaderData> {
	const [checklist, dismissed] = await Promise.all([
		deriveOnboardingChecklist({
			env,
			userId,
			personId,
			emailVerified: true,
			hasMcpClient,
			hasAccessWin: options?.hasAccessWin,
			hasSecondMcpClient: options?.hasSecondMcpClient,
		}),
		readOnboardingChecklistDismissed({ env, personId }),
	])
	return { username, items: checklist.items, dismissed }
}

export async function attachOnboardingProgress(
	env: Env,
	userId: OwnerId,
	personId: OwnerId,
	username: string,
	onboarding: OnboardingLoaderData,
) {
	const [hasAccessWin, persistedPackageName, accessWinMemorySubject] =
		await Promise.all([
			loadOnboardingAccessWin(env, userId, personId),
			loadPersistedPackageName(env, userId),
			loadOnboardingAccessWinMemorySubject(env, userId),
		])
	onboarding.hasAccessWin = hasAccessWin
	onboarding.persistedPackageName = persistedPackageName
	onboarding.accessWinMemorySubject = accessWinMemorySubject
	onboarding.checklist = await loadChecklist(
		env,
		userId,
		personId,
		username,
		onboarding.hasMcpClient,
		{
			hasAccessWin,
			hasSecondMcpClient: onboarding.hasSecondMcpClient,
		},
	)
}

export async function loadPersistedPackageName(
	env: Pick<Env, 'APP_DB'>,
	userId: OwnerId,
): Promise<string | null> {
	try {
		const packages = await listSavedPackagesByUserId(env.APP_DB, { userId })
		const name = packages[0]?.name?.trim()
		return name ? name : null
	} catch {
		return null
	}
}

/**
 * Official workspace MCP chooser cards for the wizard. When `userId` is set,
 * overlays saved MCP servers and hub connection state. Fails open to the
 * disconnected catalog so a hub or D1 blip never breaks the payload.
 */
async function loadOnboardingMcpChooserOverlay(
	env: Env,
	userId?: OwnerId | null,
) {
	if (!userId) return { settings: [], statusByServerId: undefined }
	try {
		const settings = await listMcpServerSettings({ env, userId })
		if (settings.length === 0) {
			return { settings: [], statusByServerId: undefined }
		}
		const snapshot = await loadMcpClientHubReadSnapshotOrNull({ env, userId })
		const statusByServerId = new Map(
			settings.map((setting) => {
				const server =
					snapshot?.servers.find((entry) => entry.serverId === setting.id) ??
					null
				return [
					setting.id,
					{
						connected: server?.state === 'ready',
						authorizationPending: server?.authorizationPending ?? false,
						state: server?.state ?? 'unknown',
						error: mcpServerStatusError({ setting, snapshot: server }),
					},
				] as const
			}),
		)
		return { settings, statusByServerId }
	} catch {
		return { settings: [], statusByServerId: undefined }
	}
}

export async function loadOnboardingFeaturedMcpServers(
	env: Env,
	userId?: OwnerId | null,
): Promise<Array<OnboardingFeaturedMcpServer>> {
	if (!userId) return listDisconnectedOnboardingFeaturedMcpServers()
	try {
		const overlay = await loadOnboardingMcpChooserOverlay(env, userId)
		if (overlay.settings.length === 0) {
			return listDisconnectedOnboardingFeaturedMcpServers()
		}
		return overlayOnboardingFeaturedMcpServers(overlay)
	} catch {
		return listDisconnectedOnboardingFeaturedMcpServers()
	}
}

export async function loadOnboardingCustomMcpServers(
	env: Env,
	userId?: OwnerId | null,
): Promise<Array<OnboardingCustomMcpServer>> {
	if (!userId) return []
	const overlay = await loadOnboardingMcpChooserOverlay(env, userId)
	return listOnboardingCustomMcpServers(overlay)
}

async function loadOnboardingChooserMcpState(
	env: Env,
	request: Request,
	userId?: OwnerId | null,
): Promise<{
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
}> {
	const [overlay, listings] = await Promise.all([
		loadOnboardingMcpChooserOverlay(env, userId),
		loadOnboardingMcpChooserListings(env, request),
	])
	const featuredBase =
		overlay.settings.length === 0
			? listDisconnectedOnboardingFeaturedMcpServers()
			: overlayOnboardingFeaturedMcpServers(overlay)
	return {
		featuredMcpServers: attachOnboardingMcpPackageListings(
			featuredBase,
			listings,
		),
		customMcpServers: listOnboardingCustomMcpServers(overlay),
	}
}

export async function loadOnboardingChooserFields(
	env: Env,
	request: Request,
	userId?: OwnerId | null,
) {
	const [featuredListings, chooser, featuredPlatformIntegrations] =
		await Promise.all([
			loadOnboardingFeaturedListings(env, request),
			loadOnboardingChooserMcpState(env, request, userId),
			loadPlatformIntegrationCatalog({
				env,
				userId: userId ?? null,
				order: onboardingFeaturedPlatformIntegrationSlugs,
			}),
		])
	return {
		featuredListings,
		featuredMcpServers: chooser.featuredMcpServers,
		customMcpServers: chooser.customMcpServers,
		featuredPlatformIntegrations,
		persistContext: {
			connectedWorkspaceLabel: firstConnectedOnboardingWorkspaceLabel({
				featuredMcpServers: chooser.featuredMcpServers,
				customMcpServers: chooser.customMcpServers,
			}),
			installedExampleName:
				firstInstalledOnboardingExampleName(featuredListings),
		},
	}
}

async function loadOnboardingResumeProgress(
	env: Env,
	userId: OwnerId,
	personId: OwnerId,
): Promise<OnboardingWizardProgress> {
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(env)
	const [inbound, hasAccessWin] = await Promise.all([
		loadInboundMcpConnectionState(helpers, personId),
		loadOnboardingAccessWin(env, userId, personId),
	])
	return {
		hasMcpClient: inbound.uniqueClientCount > 0,
		hasAccessWin,
		hasSecondMcpClient: hasSecondConnectedMcpClient(inbound.agents),
	}
}

export async function redirectOnboardingIndex(env: Env, request: Request) {
	const requestUrl = new URL(request.url)
	const user = await readAuthenticatedAppUser(request, env, {
		prefetchFeatureFlags: true,
	})
	if (!user) {
		return Response.redirect(
			new URL(onboardingIndexRedirectHref(requestUrl.search), request.url),
			302,
		)
	}
	if (!user.emailVerified) {
		return redirectUnverifiedToPending(request)
	}
	const progress = await loadOnboardingResumeProgress(
		env,
		personalOrgIdForPerson(user.mcpUser),
		// OAuth connections are person-owned; the chooser inventory is org-owned.
		personalOrgId(user.mcpUser.userId),
	)
	return Response.redirect(
		new URL(
			onboardingIndexRedirectHref(requestUrl.search, progress),
			request.url,
		),
		302,
	)
}

export function redirectUnverifiedToPending(request: Request) {
	const requestUrl = new URL(request.url)
	const redirectTo = normalizeRedirectTo(
		requestUrl.searchParams.get('redirectTo'),
	)
	const pendingUrl = new URL('/pending-verification', requestUrl)
	if (redirectTo) {
		pendingUrl.searchParams.set('redirectTo', redirectTo)
	}
	return Response.redirect(pendingUrl, 302)
}

export async function withOnboardingHighlights(
	env: Env,
	data: OnboardingLoaderData,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<OnboardingLoaderData> {
	if (!data.mcpServerUrl) {
		return { ...data, mcpHighlights: {} }
	}
	const snippets = collectOnboardingMcpSnippets(data.mcpServerUrl)
	const results = await highlightSnippets(env, snippets, { serverTiming })
	return {
		...data,
		mcpHighlights: highlightResultsByKey(snippets, results),
	}
}

export async function readOnboardingPageData(env: Env, request: Request) {
	const serverTiming: Array<ServerTimingEntry> = []
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		const { persistContext: _persistContext, ...chooser } =
			await pushServerTiming(serverTiming, 'listings', () =>
				loadOnboardingChooserFields(env, request),
			)
		const payload = await withOnboardingHighlights(
			env,
			{
				...loadPublicOnboardingData({ env, requestUrl: request.url }),
				...chooser,
			},
			serverTiming,
		)
		return {
			payload,
			serverTiming,
			headers: anonymousPersonalizedJsonCacheHeaders({
				personalized: false,
				request,
			}),
		}
	}
	// Keep unverified callers' setup fields empty until verification succeeds.
	const chooser = user.emailVerified
		? await pushServerTiming(serverTiming, 'listings', () =>
				loadOnboardingChooserFields(
					env,
					request,
					personalOrgIdForPerson(user.mcpUser),
				),
			)
		: null
	const onboarding = await loadOnboardingData({
		env,
		requestUrl: request.url,
		personId: personalOrgId(user.mcpUser.userId),
		username: user.username,
		emailVerified: user.emailVerified,
		...chooser,
	})
	if (user.emailVerified)
		await attachOnboardingProgress(
			env,
			personalOrgIdForPerson(user.mcpUser),
			personalOrgId(user.mcpUser.userId),
			user.username,
			onboarding,
		)
	return {
		payload: await withOnboardingHighlights(env, onboarding, serverTiming),
		serverTiming,
		headers: undefined,
	}
}
