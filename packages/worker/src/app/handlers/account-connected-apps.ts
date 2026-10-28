import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	packageAppOauthClaimLabel,
	packageAppOauthClaimLabels,
} from '#app/package-app-oauth-consent-copy.ts'
import {
	listLivePackageAppOauthGrantsForPerson,
	findPackageAppGrantCredentialMapping,
	hasCredentialMappingOutsidePackageAppRevoke,
	revokePackageAppOauthGrantScope,
	revokePackageAppOauthGrantsForPersonApp,
	type PackageAppOauthGrant,
} from '#app/package-app-oauth-grants.ts'
import {
	readPackageAppOauthScope,
	visitorNeedKeysOfScopes,
} from '#app/package-app-oauth-scopes.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { deleteMcpEventSubscriptionsForOauthClient } from '#mcp/events/subscriptions-repo.ts'
import { getSecretContextForAccountSecret } from '#app/account-secrets-data.ts'
import { deleteSecret } from '#mcp/secrets/service.ts'
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
import {
	personalOrgId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { isPackageCredentialSuppliersEnabled } from '#worker/credentials/credential-suppliers-flag.ts'
import { deleteIntegration } from '#worker/integrations/service.ts'
import { deleteMcpServer } from '#worker/mcp-client/settings-service.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	disconnectCredentialAfterRevoke,
	disconnectSelectedCredentials as deleteSelectedCredentials,
} from '#app/package-app-credential-disconnect.ts'

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
		(grant) =>
			describeAppGrant(
				input.env,
				input.user.request,
				personId,
				grant,
				resolveOrg,
			),
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

function isOptionalPackageAppScope(scope: string) {
	const parsed = readPackageAppOauthScope(scope)
	return parsed !== null && parsed !== 'profile'
}

async function describeAppGrant(
	env: Env,
	request: ConnectedAppsUser['request'],
	personId: PersonId,
	grant: PackageAppOauthGrant,
	resolveOrg: (
		handle: string,
	) => ReturnType<typeof resolvePackageAppOrgOwnerByHandle>,
): Promise<AccountConnectedAppView> {
	let appName = grant.kodyId
	let publisherName = grant.orgUsername
	let iconUrl: string | null = null
	const needDescriptions: Record<string, string> = {}
	let disconnectableCredentials: Array<DisconnectableCredential> = []
	let suppliersEnabled = false
	try {
		const org = await resolveOrg(grant.orgUsername)
		if (org) {
			publisherName = org.displayName || grant.orgUsername
			suppliersEnabled = await isPackageCredentialSuppliersEnabled({
				db: env.APP_DB,
				orgId: org.userId,
				request,
			})
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
	const orderedScopes = [...grant.scopes].sort()
	const optionalScopes = orderedScopes.filter(isOptionalPackageAppScope)
	if (suppliersEnabled) {
		disconnectableCredentials = await loadDisconnectableCredentials({
			env,
			personId,
			grantId: grant.id,
		})
	}
	const baseAllows = packageAppOauthClaimLabels(['profile']).map((label) => ({
		label,
		scope: null,
	}))
	return {
		appKey: `${grant.orgUsername}/${grant.kodyId}`,
		appName,
		publisherName,
		iconUrl,
		allows: [
			...baseAllows,
			...(await Promise.all(
				optionalScopes.map(async (scope) => ({
					label: packageAppOauthClaimLabel(scope, needDescriptions),
					scope,
					disconnectableCredentials:
						suppliersEnabled && scope.startsWith('need:')
							? await loadDisconnectableCredentials({
									env,
									personId,
									grantId: grant.id,
									needKey: scope.slice('need:'.length),
								})
							: [],
				})),
			)),
		],
		disconnectableCredentials,
		connectedAt: grant.createdAt,
		lastUsedAt: grant.lastUsedAt,
	}
}

type DisconnectableCredential = { id: string; name: string }

async function loadDisconnectableCredentials(input: {
	env: Env
	personId: PersonId
	grantId: string
	needKey?: string
}): Promise<Array<DisconnectableCredential>> {
	const credentialIds =
		input.needKey === undefined
			? await loadDisconnectableMappingIds(input.env.APP_DB, input.grantId)
			: await findPackageAppGrantCredentialMapping({
					db: input.env.APP_DB,
					grantId: input.grantId,
					needKey: input.needKey,
				})
	const ownerId = personalOrgId(input.personId)
	const candidates: Array<DisconnectableCredential> = []
	for (const id of new Set(credentialIds)) {
		if (
			await hasCredentialMappingOutsidePackageAppRevoke({
				db: input.env.APP_DB,
				credentialId: id,
				grantId: input.grantId,
				personId: input.personId,
				personOrgId: ownerId,
				needKey: input.needKey,
			})
		) {
			continue
		}
		const credential = await findPersonCredential({
			env: input.env,
			ownerId,
			id,
		})
		if (credential) candidates.push({ id, name: credential.name })
	}
	return candidates.sort((left, right) => left.name.localeCompare(right.name))
}

type PersonCredential = { id: string; name: string; family: string }

async function findPersonCredential(input: {
	env: Env
	ownerId: string
	id: string
}): Promise<PersonCredential | null> {
	return input.env.APP_DB.prepare(
		`SELECT id, name, family
		 FROM (
		   SELECT entry.id, entry.name, 'secret' AS family
		   FROM secret_entries AS entry
		   JOIN secret_buckets AS bucket ON bucket.id = entry.bucket_id
		   WHERE bucket.user_id = ? AND bucket.scope = 'user'
		     AND bucket.binding_key = '' AND bucket.deleted_at IS NULL
		     AND entry.deleted_at IS NULL
		   UNION ALL
		   SELECT id, name, 'integration' AS family
		   FROM user_integrations
		   WHERE user_id = ? AND deleted_at IS NULL
		   UNION ALL
		   SELECT id, name, 'mcp' AS family
		   FROM mcp_server_settings
		   WHERE user_id = ? AND deleted_at IS NULL
		 )
		 WHERE id = ?
		 LIMIT 1`,
	)
		.bind(input.ownerId, input.ownerId, input.ownerId, input.id)
		.first<PersonCredential>()
}

async function deletePersonCredential(input: {
	env: Env
	user: ConnectedAppsUser
	credentialId: string
}) {
	const ownerId = personalOrgId(input.user.mcpUser.userId)
	const credential = await findPersonCredential({
		env: input.env,
		ownerId,
		id: input.credentialId,
	})
	if (!credential) return false
	const audit = orgAuditWriterFromRequest(input.env, input.user.request)
	if (credential.family === 'secret') {
		return deleteSecret({
			env: input.env,
			userId: ownerId,
			scope: 'user',
			name: credential.name,
			storageContext: getSecretContextForAccountSecret({
				scope: 'user',
				packageId: null,
			}),
			audit,
		})
	}
	if (credential.family === 'integration') {
		return deleteIntegration({
			env: input.env,
			userId: ownerId,
			name: credential.name,
			audit,
		})
	}
	return deleteMcpServer({
		env: input.env,
		userId: ownerId,
		id: credential.id,
		audit,
	})
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
	disconnectCredentialIds = [],
}: MutationContext & {
	appKey: string
	disconnectCredentialIds?: Array<string>
}) {
	const parsed = parseAppKey(appKey)
	if (!parsed) {
		return operationResult(
			{ ok: false, error: 'Connected app not found.' },
			404,
		)
	}
	const grant = await listLivePackageAppOauthGrantsForPerson({
		db: env.APP_DB,
		personId: user.mcpUser.userId,
	}).then((grants) =>
		grants.find(
			(item) =>
				item.orgUsername === parsed.orgUsername &&
				item.kodyId === parsed.kodyId,
		),
	)
	const mappings = new Set(
		grant ? await loadDisconnectableMappingIds(env.APP_DB, grant.id) : [],
	)
	await revokePackageAppOauthGrantsForPersonApp({
		db: env.APP_DB,
		personId: user.mcpUser.userId,
		orgUsername: parsed.orgUsername,
		kodyId: parsed.kodyId,
	})
	if (disconnectCredentialIds.length > 0 && grant) {
		await disconnectCredentialAfterRevoke(() =>
			disconnectSelectedCredentials({
				env,
				user,
				appKey: parsed,
				grantId: grant.id,
				credentialIds: disconnectCredentialIds.filter((id) => mappings.has(id)),
			}),
		)
	}
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

export async function revokeAccountConnectedAppScope({
	request,
	env,
	user,
	appKey,
	scope,
	disconnectCredentialIds = [],
}: MutationContext & {
	appKey: string
	scope: string
	disconnectCredentialIds?: Array<string>
}) {
	const parsed = parseAppKey(appKey)
	if (!parsed || !isOptionalPackageAppScope(scope)) {
		return operationResult(
			{ ok: false, error: 'Connected app scope not found.' },
			404,
		)
	}
	const grant = await listLivePackageAppOauthGrantsForPerson({
		db: env.APP_DB,
		personId: user.mcpUser.userId,
	}).then((grants) =>
		grants.find(
			(item) =>
				item.orgUsername === parsed.orgUsername &&
				item.kodyId === parsed.kodyId,
		),
	)
	const mappedIds =
		grant && scope.startsWith('need:')
			? new Set(
					await findPackageAppGrantCredentialMapping({
						db: env.APP_DB,
						grantId: grant.id,
						needKey: scope.slice('need:'.length),
					}),
				)
			: new Set<string>()
	const revoked = await revokePackageAppOauthGrantScope({
		db: env.APP_DB,
		personId: user.mcpUser.userId,
		orgUsername: parsed.orgUsername,
		kodyId: parsed.kodyId,
		scope,
	})
	if (!revoked) {
		return operationResult(
			{ ok: false, error: 'Connected app scope not found.' },
			404,
		)
	}
	if (scope.startsWith('need:') && disconnectCredentialIds.length > 0) {
		if (grant) {
			await disconnectCredentialAfterRevoke(() =>
				disconnectSelectedCredentials({
					env,
					user,
					appKey: parsed,
					grantId: grant.id,
					needKey: scope.slice('need:'.length),
					credentialIds: disconnectCredentialIds.filter((id) =>
						mappedIds.has(id),
					),
				}),
			)
		}
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'package_app_grant_scope_revoke',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: new URL(request.url).pathname,
		clientId: appKey,
	})
	return operationResult({ ok: true as const })
}

async function loadDisconnectableMappingIds(db: D1Database, grantId: string) {
	const result = await db
		.prepare(
			`SELECT credential_ids_json
			 FROM package_app_grant_credential_mappings
			 WHERE grant_id = ?`,
		)
		.bind(grantId)
		.all<{ credential_ids_json: string }>()
	return (result.results ?? []).flatMap((row) => {
		try {
			const parsed: unknown = JSON.parse(row.credential_ids_json)
			return Array.isArray(parsed)
				? parsed.filter(
						(id): id is string => typeof id === 'string' && id.length > 0,
					)
				: []
		} catch {
			return []
		}
	})
}

async function disconnectSelectedCredentials(input: {
	env: Env
	user: ConnectedAppsUser
	appKey: { orgUsername: string; kodyId: string }
	grantId: string
	credentialIds: ReadonlyArray<string>
	needKey?: string
}) {
	const owner = await resolvePackageAppOrgOwnerByHandle({
		env: input.env,
		handle: input.appKey.orgUsername,
	})
	if (
		!owner ||
		!(await isPackageCredentialSuppliersEnabled({
			db: input.env.APP_DB,
			orgId: owner.userId,
			request: input.user.request,
		}))
	) {
		return
	}
	await deleteSelectedCredentials({
		selectedCredentialIds: input.credentialIds,
		mappedCredentialIds: new Set(input.credentialIds),
		isReferenced: (credentialId) =>
			hasCredentialMappingOutsidePackageAppRevoke({
				db: input.env.APP_DB,
				credentialId,
				grantId: input.grantId,
				personId: input.user.mcpUser.userId,
				personOrgId: personalOrgId(input.user.mcpUser.userId),
				needKey: input.needKey,
			}),
		deleteCredential: (credentialId) =>
			deletePersonCredential({
				env: input.env,
				user: input.user,
				credentialId,
			}),
	})
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
