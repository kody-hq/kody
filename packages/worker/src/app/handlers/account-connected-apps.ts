import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { packageAppOauthClaimLabels } from '#app/package-app-oauth-consent-copy.ts'
import {
	listLivePackageAppOauthGrantsForPerson,
	revokePackageAppOauthGrantsForPersonApp,
	type PackageAppOauthGrant,
} from '#app/package-app-oauth-grants.ts'
import { visitorNeedKeysOfScopes } from '#app/package-app-oauth-scopes.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { deleteMcpEventSubscriptionsForOauthClient } from '#mcp/events/subscriptions-repo.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	type AccountConnectedAppsLoaderData,
	type AccountConnectedAppView,
} from '#universal/loader-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	loadInboundMcpConnectionState,
	revokeConnectedMcpAgent,
	type InboundMcpConnectionState,
} from '#worker/connected-mcp-agents.ts'
import {
	type OAuthGrantHelpers,
	type OAuthGrantListHelpers,
} from '#worker/oauth-grants.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import {
	loadInvokeManifestBySourceId,
	resolveSavedPackageForPackageAppSlug,
} from '#worker/package-invocations/module-artifacts.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { mapWithConcurrency } from '#worker/webhooks/delivery-outcomes.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'

type ConnectedAppsUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type MutationContext = {
	request: Request
	env: Env
	user: ConnectedAppsUser
}

/**
 * `/account/connected-apps`: every package app the person signed in to with
 * Kody, and every agent (MCP OAuth client) they approved in any org. Both
 * belong to the person, so the page is not scoped to an org.
 */
export async function loadAccountConnectedAppsData(input: {
	env: Env
	user: ConnectedAppsUser
}): Promise<AccountConnectedAppsLoaderData> {
	const personId = input.user.mcpUser.userId
	const [grants, agentState] = await Promise.all([
		listLivePackageAppOauthGrantsForPerson({ db: input.env.APP_DB, personId }),
		resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
			.then((helpers) =>
				loadInboundMcpConnectionState(helpers, personalOrgId(personId), {
					env: input.env,
				}),
			)
			.catch((): InboundMcpConnectionState => ({
				uniqueClientCount: 0,
				agents: [],
				listingFailed: true,
			})),
	])
	const orgsByHandle = new Map<
		string,
		ReturnType<typeof resolvePackageAppOrgOwnerByHandle>
	>()
	const resolveOrg = (handle: string) => {
		let org = orgsByHandle.get(handle)
		if (!org) {
			org = resolvePackageAppOrgOwnerByHandle({ env: input.env, handle })
			orgsByHandle.set(handle, org)
		}
		return org
	}
	const apps = await mapWithConcurrency(
		grants,
		connectedAppLookupConcurrency,
		(grant) => describeAppGrant(input.env, grant, resolveOrg),
	)
	return {
		ok: true,
		apps,
		agents: agentState.agents.map((agent) => ({
			clientId: agent.clientId,
			label: agent.label,
			kind: agent.kind,
			connectedAt: agent.connectedAt,
			lastUsedAt: agent.lastUsedAt,
		})),
		agentsUnavailable: agentState.listingFailed === true,
	}
}

const connectedAppLookupConcurrency = 8

async function describeAppGrant(
	env: Env,
	grant: PackageAppOauthGrant,
	resolveOrg: (
		handle: string,
	) => ReturnType<typeof resolvePackageAppOrgOwnerByHandle>,
): Promise<AccountConnectedAppView> {
	let appName = grant.kodyId
	let publisherName = grant.orgUsername
	let iconUrl: string | null = null
	const needDescriptions: Record<string, string> = {}
	try {
		const org = await resolveOrg(grant.orgUsername)
		if (org) {
			publisherName = org.displayName || grant.orgUsername
			const lookup = await resolveSavedPackageForPackageAppSlug({
				db: env.APP_DB,
				userId: org.userId,
				slug: grant.kodyId,
			})
			if (lookup) {
				appName = getPackageNameLeaf(lookup.savedPackage.name)
				const source = await getEntitySourceById(
					env.APP_DB,
					lookup.savedPackage.sourceId,
				)
				iconUrl = resolvePackageListIconUrl({
					username: grant.orgUsername,
					kodyId: grant.kodyId,
					listingId: null,
					listingIconCommit: null,
					publishedCommit: source?.published_commit ?? null,
				})
				if (visitorNeedKeysOfScopes(grant.scopes).length > 0) {
					const { manifest } = await loadInvokeManifestBySourceId({
						env,
						userId: org.userId,
						sourceId: lookup.savedPackage.sourceId,
					})
					for (const [key, need] of Object.entries(
						manifest.kody.app?.visitorNeeds ?? {},
					)) {
						needDescriptions[key] = need.description
					}
				}
			}
		}
	} catch {
		// The grant still lists (and can be revoked) when the app is gone.
	}
	return {
		appKey: `${grant.orgUsername}/${grant.kodyId}`,
		appName,
		publisherName,
		iconUrl,
		allows: packageAppOauthClaimLabels(grant.scopes, needDescriptions),
		connectedAt: grant.createdAt,
		lastUsedAt: grant.lastUsedAt,
	}
}

function parseAppKey(appKey: string) {
	const [orgUsername, kodyId, extra] = appKey.split('/')
	if (!orgUsername || !kodyId || extra !== undefined) return null
	return { orgUsername, kodyId }
}

/** Revoke a person's Sign in with Kody grant for one app. */
export async function revokeAccountConnectedApp({
	request,
	env,
	user,
	appKey,
}: MutationContext & { appKey: string }) {
	const parsed = parseAppKey(appKey)
	if (!parsed) {
		return operationResult(
			{ ok: false, error: 'Connected app not found.' },
			404,
		)
	}
	await revokePackageAppOauthGrantsForPersonApp({
		db: env.APP_DB,
		personId: user.mcpUser.userId,
		orgUsername: parsed.orgUsername,
		kodyId: parsed.kodyId,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'package_app_grant_revoke',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: new URL(request.url).pathname,
		clientId: appKey,
	})
	return operationResult({ ok: true as const })
}

/** Disconnect an agent from every org the person approved it for. */
export async function revokeAccountConnectedAppAgent({
	request,
	env,
	user,
	clientId,
}: MutationContext & { clientId: string }) {
	const helpers = await resolveOAuthHelpers<OAuthGrantHelpers>(env)
	if (!helpers) {
		return operationResult(
			{ ok: false, error: 'Connected agent listing is unavailable.' },
			503,
		)
	}
	const personId = personalOrgId(user.mcpUser.userId)
	const revoked = await revokeConnectedMcpAgent({
		helpers,
		userId: personId,
		clientId,
		env,
	})
	await deleteMcpEventSubscriptionsForOauthClient({
		db: env.APP_DB,
		oauthClientId: clientId,
		userId: personId,
	})
	if ('error' in revoked) {
		return operationResult(
			{ ok: false, error: 'Connected agent not found.' },
			404,
		)
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'mcp_inbound_grant_revoke',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: new URL(request.url).pathname,
		clientId,
	})
	return operationResult({ ok: true as const })
}
