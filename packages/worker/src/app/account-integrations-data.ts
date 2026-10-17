import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
	type ConnectOauthExistingConnection,
} from '#universal/loader-data.ts'
import { type PlatformIntegrationCatalogItem } from '#universal/oauth-connect.ts'
import { loadPlatformIntegrationCatalog } from '#app/platform-integration-catalog.ts'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { toOauthAppPublic } from '#mcp/capabilities/integrations/oauth-app-shared.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	findOauthAppForProviderSetup,
	getAvailablePlatformApp,
	getJoinedIntegration,
	getOauthApp,
	listJoinedIntegrations,
	listOauthApps,
	oauthAppToSetupPrefill,
	toJoinedIntegrationConfig,
	type OauthAppSetupPrefill,
	type PlatformOauthApp,
} from '#worker/integrations/service.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import { isPlatformOauthAppDiscoverable } from '#worker/integrations/platform-apps.ts'
import { buildUserOauthAppLogoPaths } from '#worker/integrations/user-oauth-app-logo.ts'
import { backfillMissingUserOauthAppFavicons } from '#worker/integrations/user-oauth-app-favicon.ts'
import {
	attachCatalogLogoPath,
	listPlatformProviderMarks,
} from '#worker/integrations/provider-marks.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import { getOauthAppClientSecretCiphertext } from '#worker/integrations/repo.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountIntegrationRecord = AccountIntegrationListItem
export type AccountOauthAppRecord = AccountOauthAppListItem

function toAccountIntegrationRecord(
	entry: JoinedIntegration,
): AccountIntegrationRecord {
	const config = toJoinedIntegrationConfig(entry)
	return {
		...config,
		appSlug: entry.app.slug,
		provider: entry.app.provider,
		appLabel: entry.app.label,
		accountLabel: entry.connection.accountLabel,
		hasClientSecret: entry.lane === 'user' ? entry.app.hasClientSecret : false,
		...(entry.lane === 'platform'
			? {
					platformAllowedScopes: entry.app.allowedScopes,
					platformLogoPath: buildPlatformOauthAppLogoPath(entry.app),
					platformDescription: entry.app.description,
				}
			: buildUserOauthAppLogoPaths(entry.app)),
		createdAt: entry.connection.createdAt,
		updatedAt: entry.connection.updatedAt,
		usageMode: entry.connection.usageMode,
		allowedPackageIds: entry.connection.allowedPackageIds,
	}
}

/**
 * Connect-flow payload for a discoverable (enabled + published) platform app
 * the user is connecting under `requestedName`. No client secret appears:
 * the operator owns the app registration and token exchange runs host-side.
 */
function toPlatformAppPrefillRecord(
	app: PlatformOauthApp,
	requestedName: string,
): AccountIntegrationRecord {
	const providerKey = canonicalIntegrationName(requestedName) || app.slug
	return {
		name: providerKey,
		appSlug: app.slug,
		provider: app.provider,
		appLabel: app.label,
		accountLabel: null,
		tokenUrl: app.tokenUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		...(typeof app.usePkce === 'boolean' ? { usePkce: app.usePkce } : {}),
		clientId: app.clientId,
		hasClientSecret: false,
		requiredHosts: app.requiredHosts,
		...(app.tokenExchangeStyle
			? { tokenExchangeStyle: app.tokenExchangeStyle }
			: {}),
		...(app.deviceAuthorizationUrl
			? { deviceAuthorizationUrl: app.deviceAuthorizationUrl }
			: {}),
		authorization: app.authorizeUrl.trim()
			? {
					authorizeUrl: app.authorizeUrl,
					scopes: app.defaultScopes,
					scopeSeparator: app.scopeSeparator,
					extraAuthorizeParams: app.extraAuthorizeParams,
				}
			: null,
		platform: true,
		platformAllowedScopes: app.allowedScopes,
		platformLogoPath: buildPlatformOauthAppLogoPath(app),
		platformDescription: app.description,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}

/**
 * Existing connections on a draft (or disabled) platform app stay listed so
 * tokens can keep refreshing, but reconnect is bring-your-own: keep
 * endpoints and scopes, drop the operator client id and platform-lane flags
 * so the setup form appears.
 */
function toBringYourOwnReconnectRecord(
	record: AccountIntegrationRecord,
): AccountIntegrationRecord {
	return {
		...record,
		platform: false,
		// Do not keep the leftover platform slug: hasStoredConnectClientSecret
		// treats a non-platform appSlug as a user-lane app and can pick up a
		// sibling BYO client secret.
		appSlug: '',
		clientId: '',
		hasClientSecret: false,
		platformAllowedScopes: undefined,
		platformLogoPath: undefined,
		platformDescription: undefined,
	}
}

/**
 * Add-account on a leftover platform integration (`app=<platform-slug>`).
 * Reuse endpoints and scopes from a sibling platform connection the user
 * already has, but keep the new name and empty client credentials so the
 * setup form is bring-your-own.
 */
function toBringYourOwnSetupFromPlatformConnection(
	entry: Extract<JoinedIntegration, { lane: 'platform' }>,
	requestedName: string,
): AccountIntegrationRecord {
	const providerKey = canonicalIntegrationName(requestedName) || requestedName
	const record = toBringYourOwnReconnectRecord(
		toAccountIntegrationRecord(entry),
	)
	return {
		...record,
		name: providerKey,
		accountLabel: null,
		hasClientSecret: false,
	}
}

/**
 * Convert a setup prefill (exact app, sole family member, or field-wise family
 * merge) into the connect-flow payload. `requestedName` is the connection name
 * being set up — it may differ from `prefill.slug` when the app was reused
 * across accounts. Disagreed family fields are omitted / left empty so the UI
 * does not invent a secret name or endpoint.
 */
function toAppOnlyIntegrationRecord(
	prefill: OauthAppSetupPrefill,
	requestedName: string,
): AccountIntegrationRecord {
	const providerKey =
		canonicalIntegrationName(requestedName) ||
		canonicalIntegrationName(prefill.slug) ||
		prefill.slug
	return {
		name: providerKey,
		appSlug: prefill.slug,
		provider: prefill.provider,
		appLabel: prefill.label,
		accountLabel: null,
		tokenUrl: prefill.tokenUrl ?? '',
		apiBaseUrl: prefill.apiBaseUrl,
		...(prefill.flow ? { flow: prefill.flow } : {}),
		...(typeof prefill.usePkce === 'boolean'
			? { usePkce: prefill.usePkce }
			: {}),
		clientId: prefill.clientId ?? '',
		hasClientSecret: prefill.hasClientSecret,
		requiredHosts: [],
		...(prefill.tokenExchangeStyle
			? { tokenExchangeStyle: prefill.tokenExchangeStyle }
			: {}),
		...(prefill.deviceAuthorizationUrl
			? { deviceAuthorizationUrl: prefill.deviceAuthorizationUrl }
			: {}),
		authorization: prefill.authorizeUrl
			? {
					authorizeUrl: prefill.authorizeUrl,
					scopes: [],
					scopeSeparator: prefill.scopeSeparator,
					extraAuthorizeParams: prefill.extraAuthorizeParams ?? {},
				}
			: null,
		...buildUserOauthAppLogoPaths({
			slug: prefill.slug,
			logoKey: prefill.logoKey,
			logoSource: prefill.logoSource,
		}),
		createdAt: prefill.createdAt,
		updatedAt: prefill.updatedAt,
	}
}

function connectionRef(entry: JoinedIntegration) {
	return {
		name: entry.connection.name,
		accountLabel: entry.connection.accountLabel,
	}
}

function buildUserOauthAppRecords(
	apps: Awaited<ReturnType<typeof listOauthApps>>,
	joined: Awaited<ReturnType<typeof listJoinedIntegrations>>,
): Array<AccountOauthAppRecord> {
	const connectionsByAppSlug = new Map<
		string,
		Array<{ name: string; accountLabel: string | null }>
	>()
	for (const entry of joined) {
		if (entry.lane !== 'user') continue
		const existing = connectionsByAppSlug.get(entry.app.slug) ?? []
		existing.push(connectionRef(entry))
		connectionsByAppSlug.set(entry.app.slug, existing)
	}
	return apps.map((app) =>
		toOauthAppPublic(app, connectionsByAppSlug.get(app.slug) ?? []),
	)
}

function buildPlatformOauthAppRecords(
	joined: Awaited<ReturnType<typeof listJoinedIntegrations>>,
): Array<AccountOauthAppRecord> {
	const bySlug = new Map<
		string,
		{
			app: PlatformOauthApp
			connections: Array<{ name: string; accountLabel: string | null }>
		}
	>()
	for (const entry of joined) {
		if (entry.lane !== 'platform') continue
		const existing = bySlug.get(entry.app.slug)
		if (existing) {
			existing.connections.push(connectionRef(entry))
			continue
		}
		bySlug.set(entry.app.slug, {
			app: entry.app,
			connections: [connectionRef(entry)],
		})
	}
	return Array.from(bySlug.values()).map(({ app, connections }) => ({
		slug: app.slug,
		provider: app.provider,
		label: app.label,
		clientId: app.clientId,
		hasClientSecret: false,
		tokenUrl: app.tokenUrl,
		authorizeUrl: app.authorizeUrl,
		deviceAuthorizationUrl: app.deviceAuthorizationUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		tokenExchangeStyle: app.tokenExchangeStyle,
		scopeSeparator: app.scopeSeparator,
		extraAuthorizeParams: app.extraAuthorizeParams,
		connectionCount: connections.length,
		connections,
		platform: true,
		platformLogoPath: buildPlatformOauthAppLogoPath(app),
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}))
}

function buildOauthAppRecords(
	apps: Awaited<ReturnType<typeof listOauthApps>>,
	joined: Awaited<ReturnType<typeof listJoinedIntegrations>>,
): Array<AccountOauthAppRecord> {
	return [
		...buildUserOauthAppRecords(apps, joined),
		...buildPlatformOauthAppRecords(joined),
	].sort((left, right) => {
		const slugCompare = left.slug.localeCompare(right.slug)
		if (slugCompare !== 0) return slugCompare
		return Number(Boolean(left.platform)) - Number(Boolean(right.platform))
	})
}

export async function loadAccountIntegrationsData(
	env: Env,
	user: AuthenticatedUser,
	options?: {
		waitUntil?: (promise: Promise<unknown>) => void
		approvalName?: string
		approvalPackageId?: string
	},
): Promise<{
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationRecord>
	apps: Array<AccountOauthAppRecord>
	savedPackages: Array<{ id: string; kodyId: string }>
	approval: {
		name: string
		packageId: string
		packageKodyId: string | null
		usageMode: 'any' | 'packages'
		alreadyGranted: boolean
	} | null
	platformCatalog: Array<PlatformIntegrationCatalogItem>
}> {
	const userId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	const [joined, apps, savedPackages, marks, platformCatalog] =
		await Promise.all([
			listJoinedIntegrations({ env, userId }),
			listOauthApps({ env, userId }),
			listSavedPackagesByUserId(env.APP_DB, { userId }),
			listPlatformProviderMarks({ db: env.APP_DB }),
			loadPlatformIntegrationCatalog({ env, userId }),
		])
	const integrations = joined
		.map((entry) =>
			attachCatalogLogoPath(toAccountIntegrationRecord(entry), marks),
		)
		.sort((left, right) => {
			const appCompare = left.appSlug.localeCompare(right.appSlug)
			if (appCompare !== 0) return appCompare
			return left.name.localeCompare(right.name)
		})

	await backfillMissingUserOauthAppFavicons({
		db: env.APP_DB,
		env,
		userId,
		apps,
		waitUntil: options?.waitUntil,
	})

	const packageRecords = savedPackages.map((entry) => ({
		id: entry.id,
		kodyId: entry.kodyId,
	}))
	const approvalName = options?.approvalName?.trim() ?? ''
	const approvalPackageId = options?.approvalPackageId?.trim() ?? ''
	let approval: {
		name: string
		packageId: string
		packageKodyId: string | null
		usageMode: 'any' | 'packages'
		alreadyGranted: boolean
	} | null = null
	if (approvalName && approvalPackageId) {
		const connection = integrations.find((entry) => entry.name === approvalName)
		if (connection) {
			const savedPackage = packageRecords.find(
				(entry) => entry.id === approvalPackageId,
			)
			const usageMode = connection.usageMode === 'packages' ? 'packages' : 'any'
			approval = {
				name: approvalName,
				packageId: approvalPackageId,
				packageKodyId: savedPackage?.kodyId ?? null,
				usageMode,
				alreadyGranted:
					usageMode === 'any' ||
					(connection.allowedPackageIds ?? []).includes(approvalPackageId),
			}
		}
	}

	return {
		ok: true,
		email: user.email,
		username: user.username,
		integrations,
		apps: buildOauthAppRecords(apps, joined).map((app) =>
			attachCatalogLogoPath(app, marks),
		),
		savedPackages: packageRecords,
		approval,
		platformCatalog,
	}
}

export async function loadAccountOauthAppBySlug(
	env: Env,
	user: AuthenticatedUser,
	slug: string,
): Promise<AccountOauthAppRecord | null> {
	const userId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	const app = await getOauthApp({ env, userId, slug })
	if (!app) return null
	const [joined, marks] = await Promise.all([
		listJoinedIntegrations({ env, userId }),
		listPlatformProviderMarks({ db: env.APP_DB }),
	])
	const connections = joined
		.filter((entry) => entry.lane === 'user' && entry.app.slug === app.slug)
		.map(({ connection }) => ({
			name: connection.name,
			accountLabel: connection.accountLabel,
		}))
	return attachCatalogLogoPath(
		toOauthAppPublic(
			{ ...app, connectionCount: connections.length },
			connections,
		),
		marks,
	)
}

export function readConnectOauthLookupOptions(searchParams: URLSearchParams) {
	const appParam = searchParams.get('app')?.trim()
	const platformParam = searchParams.get('platform')?.trim()
	return {
		appSlug: appParam
			? (normalizeProviderKey(appParam) ?? undefined)
			: undefined,
		platformSlug: platformParam
			? (normalizeProviderKey(platformParam) ?? undefined)
			: undefined,
	}
}

async function resolveAccountIntegrationByName(
	env: Env,
	user: AuthenticatedUser,
	name: string,
	options?: {
		/**
		 * Saved bring-your-own app to reuse under a new connection name
		 * (`app=<slug>`): connecting `work` on the google app must not depend
		 * on inferring that app from the typed name.
		 */
		appSlug?: string
		/**
		 * Built-in intent from a discovery surface (`platform=<slug>`):
		 * connect that platform app under `name`. Only enabled + published
		 * apps resolve; any other slug falls through to bring-your-own.
		 */
		platformSlug?: string
	},
): Promise<AccountIntegrationRecord | null> {
	// 1. Existing connection (reconnect) — connection name, not app slug.
	// Platform-lane rows reconnect through the built-in only while it is
	// discoverable; draft or disabled built-ins reconnect bring-your-own.
	// This runs before `platform=` so a built-in link never silently converts
	// a bring-your-own connection that already holds the name.
	const joined = await getJoinedIntegration({
		env,
		userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
		name,
	})
	if (joined) {
		const record = toAccountIntegrationRecord(joined)
		if (
			joined.lane === 'platform' &&
			!isPlatformOauthAppDiscoverable(joined.app)
		) {
			return toBringYourOwnReconnectRecord(record)
		}
		return record
	}

	if (options?.platformSlug) {
		const platformApp = await getAvailablePlatformApp({
			env,
			slug: options.platformSlug,
		})
		if (platformApp) return toPlatformAppPrefillRecord(platformApp, name)
	}

	if (options?.appSlug) {
		const app = await getOauthApp({
			env,
			userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
			slug: options.appSlug,
		})
		if (app) {
			return toAppOnlyIntegrationRecord(oauthAppToSetupPrefill(app), name)
		}
		const siblings = await listJoinedIntegrations({
			env,
			userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
		})
		const platformSibling = siblings.find(
			(entry): entry is Extract<JoinedIntegration, { lane: 'platform' }> =>
				entry.lane === 'platform' && entry.app.slug === options.appSlug,
		)
		if (platformSibling) {
			return isPlatformOauthAppDiscoverable(platformSibling.app)
				? toPlatformAppPrefillRecord(platformSibling.app, name)
				: toBringYourOwnSetupFromPlatformConnection(platformSibling, name)
		}
	}

	// 2–3. Exact app slug, else field-wise provider-family prefill (shared
	// client id across github/github-kent, shared google app, etc.).
	const prefill = await findOauthAppForProviderSetup({
		env,
		userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
		name,
	})
	if (prefill) {
		return toAppOnlyIntegrationRecord(prefill, name)
	}

	return null
}

export async function loadAccountIntegrationByName(
	env: Env,
	user: AuthenticatedUser,
	name: string,
	options?: Parameters<typeof resolveAccountIntegrationByName>[3],
): Promise<AccountIntegrationRecord | null> {
	const [record, marks] = await Promise.all([
		resolveAccountIntegrationByName(env, user, name, options),
		listPlatformProviderMarks({ db: env.APP_DB }),
	])
	return record ? attachCatalogLogoPath(record, marks) : null
}

/**
 * The connection currently stored under `name`, summarized so the connect
 * page can warn before an OAuth flow would replace it with a different app.
 */
export async function loadExistingConnectionSummary(
	env: Env,
	user: AuthenticatedUser,
	name: string,
): Promise<ConnectOauthExistingConnection | null> {
	const joined = await getJoinedIntegration({
		env,
		userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
		name,
	})
	if (!joined) return null
	return { lane: joined.lane, appSlug: joined.app.slug }
}

/**
 * True when the user-lane app already stores a client-secret ciphertext
 * the connect page can reuse.
 */
export async function hasStoredConnectClientSecret(
	env: Env,
	user: AuthenticatedUser,
	name: string,
	record: AccountIntegrationRecord | null,
): Promise<boolean> {
	void name
	if (record?.hasClientSecret) return true
	if (!record?.appSlug || record.platform) return false
	const storedCiphertext = await getOauthAppClientSecretCiphertext({
		db: env.APP_DB,
		userId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
		slug: record.appSlug,
	})
	return Boolean(storedCiphertext)
}
