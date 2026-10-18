import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { toIntegrationAuthFailureView } from '#universal/connection-trouble.ts'
import {
	canonicalIntegrationName,
	integrationConfigSchema,
	normalizeIntegrationAuthorization,
	normalizeIntegrationConfig,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { normalizeAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { stampFirstIntegration } from '#worker/identity/activation-stamps.ts'
import {
	getDiscoverablePlatformOauthApp,
	getPlatformOauthAppBySlug,
	listDiscoverablePlatformOauthApps,
	type PlatformOauthApp,
} from './platform-apps.ts'
import {
	addPlatformIntegrationRequiredHosts,
	countConnectionsForApp,
	deleteIntegrationConnection,
	deleteOauthApp,
	findOauthAppByAppTuple,
	findOauthAppByClientCredentials,
	getJoinedIntegrationByName,
	getOauthAppBySlug,
	listJoinedIntegrationsForUser,
	listOauthAppsByProvider,
	listOauthAppsWithConnectionCounts,
	updateIntegrationUsage,
	updateOauthAppClientCredentials,
	upsertIntegrationConnection,
	upsertOauthApp,
} from './repo.ts'
import { providerFromSlug } from './provider-from-slug.ts'
import {
	normalizeIntegrationUsageMode,
	type IntegrationUsageMode,
} from './usage-mode.ts'
import {
	deleteUserOauthAppLogoAsset,
	setUserOauthAppLogo,
} from './user-oauth-app-logo.ts'
import { scheduleUserOauthAppFaviconFill } from './user-oauth-app-favicon.ts'
import {
	type JoinedIntegration,
	type UserIntegrationConnection,
	type UserOauthApp,
	type UserOauthAppWithConnectionCount,
} from './types.ts'

export type { IntegrationConfig, PlatformOauthApp }

type IntegrationWriteEnv = Pick<Env, 'APP_DB'> &
	Partial<Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES' | 'SECRET_STORE_KEY'>>

type LogoWriteInput = {
	logoBase64?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * App-level OAuth config (no connection / token secret fields). Used by
 * connect-flow setup to persist a client id before token exchange.
 */
export type OauthAppConfigInput = {
	name: string
	tokenUrl: string
	apiBaseUrl?: string | null
	flow: IntegrationConfig['flow']
	usePkce?: boolean | null
	clientId: string
	tokenExchangeStyle?: IntegrationConfig['tokenExchangeStyle']
	deviceAuthorizationUrl?: string | null
	authorization?: {
		authorizeUrl: string
		scopes?: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
}

type OauthAppWriteConfig = {
	name: string
	tokenUrl: string
	apiBaseUrl: string | null
	flow: IntegrationConfig['flow']
	usePkce?: boolean
	clientId: string
	tokenExchangeStyle?: NonNullable<IntegrationConfig['tokenExchangeStyle']>
	deviceAuthorizationUrl?: string | null
	authorization?: NonNullable<IntegrationConfig['authorization']>
}

export function toIntegrationConfig(
	app: UserOauthApp,
	connection: UserIntegrationConnection,
): IntegrationConfig {
	const authorization =
		app.authorizeUrl == null
			? null
			: {
					authorizeUrl: app.authorizeUrl,
					scopes: connection.scopes,
					scopeSeparator: app.scopeSeparator,
					extraAuthorizeParams: app.extraAuthorizeParams,
				}
	return normalizeIntegrationConfig({
		name: connection.name,
		tokenUrl: app.tokenUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		clientId: app.clientId,
		requiredHosts: connection.requiredHosts,
		tokenExchangeStyle: app.tokenExchangeStyle,
		deviceAuthorizationUrl: app.deviceAuthorizationUrl,
		authorization,
		...usageFields(connection),
	})
}

export function toPlatformIntegrationConfig(
	app: PlatformOauthApp,
	connection: UserIntegrationConnection,
): IntegrationConfig {
	// The shared client secret never has a user-facing secret name; the
	// `platform` marker routes sandbox token refresh through the host-side
	// `integrationTokenRefresh` capability instead.
	const authorization = !app.authorizeUrl.trim()
		? null
		: {
				authorizeUrl: app.authorizeUrl,
				scopes: connection.scopes,
				scopeSeparator: app.scopeSeparator,
				extraAuthorizeParams: app.extraAuthorizeParams,
			}
	return {
		...normalizeIntegrationConfig({
			name: connection.name,
			tokenUrl: app.tokenUrl,
			apiBaseUrl: app.apiBaseUrl,
			flow: app.flow,
			usePkce: app.usePkce,
			clientId: app.clientId,
			requiredHosts: normalizeAllowedHosts([
				...connection.requiredHosts,
				...app.requiredHosts,
			]),
			tokenExchangeStyle: app.tokenExchangeStyle,
			deviceAuthorizationUrl: app.deviceAuthorizationUrl,
			authorization,
			...usageFields(connection),
		}),
		platform: true,
	}
}

function usageFields(connection: UserIntegrationConnection) {
	if (connection.usageMode !== 'packages') return {}
	return {
		usageMode: 'packages' as const,
		allowedPackageIds: connection.allowedPackageIds,
	}
}

export function toJoinedIntegrationConfig(
	joined: JoinedIntegration,
): IntegrationConfig {
	const config = (() => {
		switch (joined.lane) {
			case 'user':
				return toIntegrationConfig(joined.app, joined.connection)
			case 'platform':
				return toPlatformIntegrationConfig(joined.app, joined.connection)
			default: {
				const exhaustiveCheck: never = joined
				throw new Error(
					`Unhandled integration lane: ${String(exhaustiveCheck)}`,
				)
			}
		}
	})()
	const withId = { ...config, credentialId: joined.connection.credentialId }
	const snapshot = joined.connection.lastAuthFailure
	if (!snapshot) return withId
	return {
		...withId,
		lastAuthFailure: toIntegrationAuthFailureView({
			name: joined.connection.name,
			accountLabel: joined.connection.accountLabel,
			lane: joined.lane,
			reason: snapshot.reason,
			occurredAt: snapshot.occurredAt,
			providerError: snapshot.providerError,
			providerErrorDescription: snapshot.providerErrorDescription,
			httpStatus: snapshot.httpStatus,
		}),
	}
}

export async function listIntegrations(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<IntegrationConfig>> {
	const rows = await listJoinedIntegrations(input)
	return rows.map(toJoinedIntegrationConfig)
}

export async function listJoinedIntegrations(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<JoinedIntegration>> {
	const joined = await listJoinedIntegrationsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return Promise.all(
		joined.map((entry) =>
			refreshPlatformIntegrationRequiredHosts(input.env.APP_DB, entry),
		),
	)
}

export async function getIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<IntegrationConfig | null> {
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: input.name,
	})
	if (!joined) return null
	return toJoinedIntegrationConfig(joined)
}

export async function getJoinedIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<JoinedIntegration | null> {
	const name = canonicalIntegrationName(input.name)
	if (!name) return null
	const joined = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!joined) return null
	return refreshPlatformIntegrationRequiredHosts(input.env.APP_DB, joined)
}

async function refreshPlatformIntegrationRequiredHosts(
	db: D1Database,
	joined: JoinedIntegration,
): Promise<JoinedIntegration> {
	if (joined.lane === 'user') return joined
	const requiredHosts = normalizeAllowedHosts([
		...joined.connection.requiredHosts,
		...joined.app.requiredHosts,
	])
	if (
		requiredHosts.length === joined.connection.requiredHosts.length &&
		requiredHosts.every(
			(host, index) => host === joined.connection.requiredHosts[index],
		)
	) {
		return joined
	}
	await addPlatformIntegrationRequiredHosts({
		db,
		userId: joined.connection.userId,
		name: joined.connection.name,
		hosts: joined.app.requiredHosts,
	})
	return {
		...joined,
		connection: {
			...joined.connection,
			requiredHosts,
		},
	}
}

export async function upsertIntegration(
	input: {
		env: IntegrationWriteEnv
		userId: string
		config: IntegrationConfig
		description?: string | null
		accountLabel?: string | null
	} & LogoWriteInput,
): Promise<IntegrationConfig> {
	const parsed = integrationConfigSchema.parse(input.config)
	const config = normalizeIntegrationConfig(parsed)
	const now = new Date().toISOString()
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name: config.name,
	})

	const { appSlug } = await resolveOrCreateOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		config: oauthAppWriteConfigFromIntegration(config),
		existingConnectionApp: existing?.lane === 'user' ? existing.app : null,
	})

	await upsertIntegrationConnection({
		db: input.env.APP_DB,
		row: {
			user_id: input.userId,
			name: config.name,
			app_slug: appSlug,
			platform_app_slug: null,
			account_label:
				input.accountLabel === undefined
					? (existing?.connection.accountLabel ?? null)
					: input.accountLabel?.trim() || null,
			description:
				input.description === undefined
					? (existing?.connection.description ?? '')
					: (input.description?.trim() ?? ''),
			scopes_json: JSON.stringify(config.authorization?.scopes ?? []),
			required_hosts_json: JSON.stringify(
				normalizeAllowedHosts(config.requiredHosts ?? []),
			),
			connected_at: existing?.connection.connectedAt ?? null,
			token_refreshed_at: existing?.connection.tokenRefreshedAt ?? null,
			created_at: existing?.connection.createdAt ?? now,
			updated_at: now,
		},
	})
	if (!existing) {
		await stampFirstIntegration(
			input.env.APP_DB,
			{ stableUserId: input.userId, at: now },
			input.env,
		)
	}

	if (existing && existing.lane === 'user' && existing.app.slug !== appSlug) {
		await deleteOauthAppIfNoConnections({
			env: input.env,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
	}

	await applyUserOauthAppLogoWrite({
		env: input.env,
		userId: input.userId,
		slug: appSlug,
		logoBase64: input.logoBase64,
		waitUntil: input.waitUntil,
	})

	const saved = await getIntegration({
		env: input.env,
		userId: input.userId,
		name: config.name,
	})
	if (!saved) {
		throw new Error(`Failed to upsert integration "${config.name}".`)
	}
	return saved
}

/**
 * Persist an OAuth app row (client id + endpoints) without creating a
 * connection. Used by the connect-oauth setup step so the client id survives
 * abandoning the flow before token exchange.
 *
 * Shares resolve/create rules with `upsertIntegration`'s app branch, including
 * full-tuple reuse and reclaiming a connectionless preferred slug when the
 * user re-runs setup with an edited client id.
 */
export async function upsertOauthAppWithoutConnection(
	input: {
		env: IntegrationWriteEnv
		userId: string
		config: OauthAppConfigInput
	} & LogoWriteInput,
): Promise<UserOauthApp> {
	const config = normalizeOauthAppConfig(input.config)
	const { appSlug } = await resolveOrCreateOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		config,
		existingConnectionApp: null,
	})
	await applyUserOauthAppLogoWrite({
		env: input.env,
		userId: input.userId,
		slug: appSlug,
		logoBase64: input.logoBase64,
		waitUntil: input.waitUntil,
	})
	const saved = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: appSlug,
	})
	if (!saved) {
		throw new Error(`Failed to persist OAuth app "${appSlug}".`)
	}
	return saved
}

export async function deleteIntegration(input: {
	env: IntegrationWriteEnv
	userId: string
	name: string
}): Promise<boolean> {
	const name = canonicalIntegrationName(input.name)
	if (!name) return false
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!existing) return false
	const deleted = await deleteIntegrationConnection({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!deleted) return false
	// Platform apps are operator-owned; deleting a built-in connection never
	// cleans up the shared app row.
	if (existing.lane === 'user') {
		await deleteOauthAppIfNoConnections({
			env: input.env,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
	}
	return true
}

/**
 * Connect a user to a platform (built-in) OAuth app. Token secrets are the
 * user's own; only the app registration (client id + endpoints + shared
 * secret) is operator-owned.
 */
export async function upsertPlatformIntegration(input: {
	env: IntegrationWriteEnv
	userId: string
	platformAppSlug: string
	name?: string | null
	scopes: Array<string>
	accountLabel?: string | null
	description?: string | null
}): Promise<IntegrationConfig> {
	const app = await getPlatformOauthAppBySlug({
		db: input.env.APP_DB,
		slug: input.platformAppSlug,
	})
	if (!app) {
		throw new Error(
			`Platform integration "${input.platformAppSlug}" is not available.`,
		)
	}
	const name =
		canonicalIntegrationName(input.name?.trim() || app.slug) || app.slug
	const scopes = assertScopesAllowedForPlatformApp(app, input.scopes)
	const tokenHost = safeParseHost(app.tokenUrl)
	const requiredHosts = normalizeAllowedHosts([
		...app.requiredHosts,
		...(tokenHost ? [tokenHost] : []),
		...(app.apiBaseUrl ? [safeParseHost(app.apiBaseUrl) ?? ''] : []),
	])

	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	const now = new Date().toISOString()
	await upsertIntegrationConnection({
		db: input.env.APP_DB,
		row: {
			user_id: input.userId,
			name,
			app_slug: null,
			platform_app_slug: app.slug,
			account_label:
				input.accountLabel === undefined
					? (existing?.connection.accountLabel ?? null)
					: input.accountLabel?.trim() || null,
			description:
				input.description === undefined
					? (existing?.connection.description ?? '')
					: (input.description?.trim() ?? ''),
			scopes_json: JSON.stringify(scopes),
			required_hosts_json: JSON.stringify(requiredHosts),
			connected_at: now,
			token_refreshed_at: existing?.connection.tokenRefreshedAt ?? null,
			created_at: existing?.connection.createdAt ?? now,
			updated_at: now,
		},
	})
	if (!existing) {
		await stampFirstIntegration(
			input.env.APP_DB,
			{ stableUserId: input.userId, at: now },
			input.env,
		)
	}

	// Converting an existing user-lane connection to the platform lane leaves
	// its old app row behind when it was the sole connection; clean it up the
	// same way a user-lane app switch does.
	if (existing?.lane === 'user') {
		await deleteOauthAppIfNoConnections({
			env: input.env,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
	}

	const saved = await getIntegration({
		env: input.env,
		userId: input.userId,
		name,
	})
	if (!saved) {
		throw new Error(`Failed to save platform integration "${name}".`)
	}
	return saved
}

/**
 * The allowed-scope menu is a strict allowlist: an empty menu permits only
 * scope-less connections. Callers must run this before persisting anything
 * (including token secrets), so a rejected scope set leaves no state behind.
 * Returns the normalized requested scopes.
 */
export function assertScopesAllowedForPlatformApp(
	app: PlatformOauthApp,
	requestedScopes: Array<string>,
): Array<string> {
	const allowedScopes = new Set(app.allowedScopes)
	const scopes = Array.from(
		new Set(requestedScopes.map((scope) => scope.trim()).filter(Boolean)),
	)
	const disallowed = scopes.filter((scope) => !allowedScopes.has(scope))
	if (disallowed.length > 0) {
		throw new Error(
			`Scopes not allowed for platform integration "${app.slug}": ${disallowed.join(', ')}.`,
		)
	}
	return scopes
}

/**
 * Platform apps users may discover and newly connect: enabled + published.
 * Draft apps keep serving existing connections (refresh, fetch) but never
 * appear here.
 */
export async function listAvailablePlatformApps(input: {
	env: Pick<Env, 'APP_DB'>
}): Promise<Array<PlatformOauthApp>> {
	return listDiscoverablePlatformOauthApps({ db: input.env.APP_DB })
}

export async function getAvailablePlatformApp(input: {
	env: Pick<Env, 'APP_DB'>
	slug: string
}): Promise<PlatformOauthApp | null> {
	return getDiscoverablePlatformOauthApp({
		db: input.env.APP_DB,
		slug: input.slug,
	})
}

async function deleteOauthAppIfNoConnections(input: {
	env: IntegrationWriteEnv
	userId: string
	appSlug: string
}): Promise<void> {
	const remaining = await countConnectionsForApp({
		db: input.env.APP_DB,
		userId: input.userId,
		appSlug: input.appSlug,
	})
	if (remaining !== 0) return
	const existing = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.appSlug,
	})
	const deleted = await deleteOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.appSlug,
	})
	if (!deleted || !existing) return
	if (input.env.COMMUNITY_ASSETS) {
		await deleteUserOauthAppLogoAsset({
			env: { COMMUNITY_ASSETS: input.env.COMMUNITY_ASSETS },
			logoKey: existing.logoKey ?? null,
		})
	}
}

export async function listOauthApps(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<UserOauthAppWithConnectionCount>> {
	return listOauthAppsWithConnectionCounts({
		db: input.env.APP_DB,
		userId: input.userId,
	})
}

export async function getOauthApp(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	slug: string
}): Promise<UserOauthApp | null> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	if (!slug) return null
	return getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
}

/**
 * App-level fields the connect-flow setup UI can prefill. Exact slug / sole
 * family member returns every field from that app. Multi-app family fallback
 * fills each field only when every candidate agrees; disagreed fields are
 * null so the UI does not invent a secret name or endpoint.
 */
export type OauthAppSetupPrefill = {
	userId: string
	slug: string
	provider: string
	label: string | null
	clientId: string | null
	hasClientSecret: boolean | null
	tokenUrl: string | null
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	apiBaseUrl: string | null
	flow: UserOauthApp['flow'] | null
	usePkce: boolean | null
	tokenExchangeStyle: UserOauthApp['tokenExchangeStyle']
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string> | null
	logoKey: string | null
	logoSource: UserOauthApp['logoSource']
	createdAt: string
	updatedAt: string
}

/**
 * Resolve an OAuth app for connect-flow setup when there is no connection
 * named `name` yet. Exact slug match first; otherwise the provider family
 * derived via `providerFromSlug` (e.g. `google-calendar` → `google`).
 *
 * Family fallback merges field-by-field: a field is prefilled only when every
 * candidate agrees on it (e.g. shared `clientId` with differing endpoints
 * still prefills the client id and leaves disagreed fields empty).
 */
export async function findOauthAppForProviderSetup(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<OauthAppSetupPrefill | null> {
	const slug = canonicalizeOauthAppSlug(input.name)
	if (!slug) return null

	const exact = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (exact) return oauthAppToSetupPrefill(exact)

	const family = providerFromSlug(slug)
	const candidates = await listOauthAppsByProvider({
		db: input.env.APP_DB,
		userId: input.userId,
		provider: family,
	})
	if (candidates.length === 0) return null
	if (candidates.length === 1) {
		const sole = candidates[0]
		return sole ? oauthAppToSetupPrefill(sole) : null
	}

	const merged = mergeOauthAppFamilyPrefill({
		userId: input.userId,
		family,
		candidates,
	})
	return setupPrefillHasAgreedField(merged) ? merged : null
}

export function oauthAppToSetupPrefill(
	app: UserOauthApp,
): OauthAppSetupPrefill {
	return {
		userId: app.userId,
		slug: app.slug,
		provider: app.provider,
		label: app.label,
		clientId: app.clientId,
		hasClientSecret: app.hasClientSecret,
		tokenUrl: app.tokenUrl,
		authorizeUrl: app.authorizeUrl,
		deviceAuthorizationUrl: app.deviceAuthorizationUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		tokenExchangeStyle: app.tokenExchangeStyle,
		scopeSeparator: app.scopeSeparator,
		extraAuthorizeParams: app.extraAuthorizeParams,
		logoKey: app.logoKey ?? null,
		logoSource: app.logoSource ?? null,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}

function mergeOauthAppFamilyPrefill(input: {
	userId: string
	family: string
	candidates: Array<UserOauthApp>
}): OauthAppSetupPrefill {
	const { candidates, family, userId } = input
	const first = candidates[0]
	if (!first) {
		throw new Error(
			'mergeOauthAppFamilyPrefill requires at least one candidate.',
		)
	}
	return {
		userId,
		slug: family,
		provider: family,
		label: null,
		clientId: agreedSetupValue(candidates.map((app) => app.clientId)),
		hasClientSecret: agreedSetupValue(
			candidates.map((app) => app.hasClientSecret),
		),
		tokenUrl: agreedSetupValue(candidates.map((app) => app.tokenUrl)),
		authorizeUrl: agreedSetupValue(candidates.map((app) => app.authorizeUrl)),
		deviceAuthorizationUrl: agreedSetupValue(
			candidates.map((app) => app.deviceAuthorizationUrl),
		),
		apiBaseUrl: agreedSetupValue(candidates.map((app) => app.apiBaseUrl)),
		flow: agreedSetupValue(candidates.map((app) => app.flow)),
		usePkce: agreedSetupValue(candidates.map((app) => app.usePkce)),
		tokenExchangeStyle: agreedSetupValue(
			candidates.map((app) => app.tokenExchangeStyle),
		),
		scopeSeparator: agreedSetupValue(
			candidates.map((app) => app.scopeSeparator),
		),
		extraAuthorizeParams: agreedSetupValue(
			candidates.map((app) => app.extraAuthorizeParams),
			sameExtraAuthorizeParams,
		),
		logoKey: null,
		logoSource: null,
		createdAt: first.createdAt,
		updatedAt: first.updatedAt,
	}
}

function agreedSetupValue<T>(
	values: Array<T>,
	equal: (left: T, right: T) => boolean = Object.is,
): T | null {
	const first = values[0]
	if (first === undefined) return null
	return values.every((value) => equal(value, first)) ? first : null
}

function sameExtraAuthorizeParams(
	left: Record<string, string>,
	right: Record<string, string>,
) {
	return JSON.stringify(left) === JSON.stringify(right)
}

function setupPrefillHasAgreedField(prefill: OauthAppSetupPrefill) {
	return Boolean(
		prefill.clientId ||
		prefill.hasClientSecret ||
		prefill.tokenUrl ||
		prefill.authorizeUrl ||
		prefill.deviceAuthorizationUrl ||
		prefill.apiBaseUrl ||
		prefill.flow ||
		typeof prefill.usePkce === 'boolean' ||
		prefill.tokenExchangeStyle ||
		prefill.scopeSeparator ||
		(prefill.extraAuthorizeParams &&
			Object.keys(prefill.extraAuthorizeParams).length > 0),
	)
}

export async function rotateOauthAppClientCredentials(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	slug: string
	clientId: string
}): Promise<UserOauthApp> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	const clientId = input.clientId.trim()
	if (!slug) throw new Error('OAuth app slug is required.')
	if (!clientId) throw new Error('Client id is required.')

	const existing = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!existing) {
		throw new Error(`OAuth app "${slug}" was not found for this user.`)
	}

	const conflicting = await findOauthAppByClientCredentials({
		db: input.env.APP_DB,
		userId: input.userId,
		clientId,
	})
	if (conflicting && conflicting.slug !== slug) {
		throw new Error(
			`Another OAuth app ("${conflicting.slug}") already uses these client credentials.`,
		)
	}

	const updated = await updateOauthAppClientCredentials({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
		clientId,
	})
	if (!updated) {
		throw new Error(`Failed to rotate credentials for OAuth app "${slug}".`)
	}
	const app = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!app) {
		throw new Error(`OAuth app "${slug}" was not found after rotation.`)
	}
	return app
}

export async function deleteOauthAppWithConnections(input: {
	env: IntegrationWriteEnv
	userId: string
	slug: string
}): Promise<{ deleted: boolean; connectionNames: Array<string> }> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	if (!slug) return { deleted: false, connectionNames: [] }
	const existing = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!existing) return { deleted: false, connectionNames: [] }

	const joined = await listJoinedIntegrationsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	const connectionNames: Array<string> = []
	for (const entry of joined) {
		if (entry.lane !== 'user' || entry.app.slug !== existing.slug) continue
		const deleted = await deleteIntegrationConnection({
			db: input.env.APP_DB,
			userId: input.userId,
			name: entry.connection.name,
		})
		if (deleted) connectionNames.push(entry.connection.name)
	}

	const deleted = await deleteOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: existing.slug,
	})
	if (deleted && input.env.COMMUNITY_ASSETS) {
		await deleteUserOauthAppLogoAsset({
			env: { COMMUNITY_ASSETS: input.env.COMMUNITY_ASSETS },
			logoKey: existing.logoKey ?? null,
		})
	}
	return { deleted, connectionNames }
}

export async function deleteOauthAppIfUnused(input: {
	env: IntegrationWriteEnv
	userId: string
	slug: string
}): Promise<boolean> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	if (!slug) return false
	const existing = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!existing) return false
	const connectionCount = await countConnectionsForApp({
		db: input.env.APP_DB,
		userId: input.userId,
		appSlug: existing.slug,
	})
	if (connectionCount > 0) {
		throw new Error(
			`OAuth app "${slug}" still has ${connectionCount} connection${connectionCount === 1 ? '' : 's'}.`,
		)
	}
	const deleted = await deleteOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (deleted && input.env.COMMUNITY_ASSETS) {
		await deleteUserOauthAppLogoAsset({
			env: { COMMUNITY_ASSETS: input.env.COMMUNITY_ASSETS },
			logoKey: existing.logoKey ?? null,
		})
	}
	return deleted
}

async function applyUserOauthAppLogoWrite(input: {
	env: IntegrationWriteEnv
	userId: string
	slug: string
	logoBase64?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (!input.env.COMMUNITY_ASSETS || !input.env.IMAGES) return
	const env = {
		APP_DB: input.env.APP_DB,
		COMMUNITY_ASSETS: input.env.COMMUNITY_ASSETS,
		IMAGES: input.env.IMAGES,
	}
	if (input.logoBase64 !== undefined) {
		await setUserOauthAppLogo({
			db: input.env.APP_DB,
			env,
			userId: input.userId,
			slug: input.slug,
			sourceBytes:
				input.logoBase64 === null ? null : base64ToBytes(input.logoBase64),
			source: 'upload',
		})
	}
	await scheduleUserOauthAppFaviconFill({
		db: input.env.APP_DB,
		env,
		userId: input.userId,
		slug: input.slug,
		waitUntil: input.waitUntil,
	})
}

function canonicalizeOauthAppSlug(slug: string) {
	return canonicalIntegrationName(slug.trim())
}

function oauthAppWriteConfigFromIntegration(
	config: IntegrationConfig,
): OauthAppWriteConfig {
	return {
		name: config.name,
		tokenUrl: config.tokenUrl,
		apiBaseUrl: config.apiBaseUrl ?? null,
		flow: config.flow,
		...(typeof config.usePkce === 'boolean' ? { usePkce: config.usePkce } : {}),
		clientId: config.clientId,
		...(config.tokenExchangeStyle
			? { tokenExchangeStyle: config.tokenExchangeStyle }
			: {}),
		...(config.deviceAuthorizationUrl
			? { deviceAuthorizationUrl: config.deviceAuthorizationUrl }
			: {}),
		...(config.authorization ? { authorization: config.authorization } : {}),
	}
}

function normalizeOauthAppConfig(
	value: OauthAppConfigInput,
): OauthAppWriteConfig {
	const preferredSlug = canonicalIntegrationName(value.name)
	if (!preferredSlug) {
		throw new Error('Provider must contain letters or numbers.')
	}
	const clientId = value.clientId.trim()
	if (!clientId) {
		throw new Error('Client ID is required.')
	}
	const tokenUrl = value.tokenUrl.trim()
	if (!tokenUrl) {
		throw new Error('Token URL is required.')
	}
	const authorization = value.authorization
		? normalizeIntegrationAuthorization({
				authorizeUrl: value.authorization.authorizeUrl,
				scopes: value.authorization.scopes ?? [],
				scopeSeparator: value.authorization.scopeSeparator ?? null,
				extraAuthorizeParams: value.authorization.extraAuthorizeParams ?? {},
			})
		: null
	// Store usePkce only when it differs from the flow default so tuple
	// matching stays aligned with normalizeIntegrationConfig / migration.
	// Device flow has no PKCE.
	const usePkce =
		value.flow === 'device'
			? null
			: typeof value.usePkce === 'boolean' &&
				  value.usePkce !== (value.flow === 'pkce')
				? value.usePkce
				: null
	const tokenExchangeStyle = value.tokenExchangeStyle ?? null
	const deviceAuthorizationUrl = value.deviceAuthorizationUrl?.trim() || null
	return {
		name: preferredSlug,
		tokenUrl,
		apiBaseUrl: value.apiBaseUrl?.trim() || null,
		flow: value.flow,
		...(usePkce == null ? {} : { usePkce }),
		clientId,
		...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
		...(deviceAuthorizationUrl ? { deviceAuthorizationUrl } : {}),
		...(authorization ? { authorization } : {}),
	}
}

/**
 * Resolve or create the OAuth app row for this config. Shared by
 * `upsertIntegration` (then attaches a connection) and
 * `upsertOauthAppWithoutConnection` (setup with zero connections).
 */
async function resolveOrCreateOauthApp(input: {
	db: D1Database
	userId: string
	config: OauthAppWriteConfig
	existingConnectionApp: UserOauthApp | null
}): Promise<{ appSlug: string }> {
	const now = new Date().toISOString()
	const appTupleFields = buildOauthAppRow({
		userId: input.userId,
		slug: input.config.name,
		config: input.config,
		label: null,
		createdAt: now,
		updatedAt: now,
	})
	const matchedApp = await findOauthAppByAppTuple({
		db: input.db,
		userId: input.userId,
		clientId: appTupleFields.client_id,
		tokenUrl: appTupleFields.token_url,
		authorizeUrl: appTupleFields.authorize_url,
		deviceAuthorizationUrl: appTupleFields.device_authorization_url,
		apiBaseUrl: appTupleFields.api_base_url,
		flow: appTupleFields.flow,
		usePkce: appTupleFields.use_pkce,
		tokenExchangeStyle: appTupleFields.token_exchange_style,
		scopeSeparator: appTupleFields.scope_separator,
		extraAuthorizeParamsJson: appTupleFields.extra_authorize_params_json,
	})

	if (matchedApp) {
		// Additive reuse: attach/return only. Do not rewrite slug-derived
		// identity (provider), label, created_at, or updated_at on the app.
		return { appSlug: matchedApp.slug }
	}

	if (input.existingConnectionApp) {
		const siblingCount = await countConnectionsForApp({
			db: input.db,
			userId: input.userId,
			appSlug: input.existingConnectionApp.slug,
		})
		if (siblingCount <= 1) {
			// Sole owner: update app-level fields in place, keeping slug identity.
			await upsertOauthApp({
				db: input.db,
				row: buildOauthAppRow({
					userId: input.userId,
					slug: input.existingConnectionApp.slug,
					config: input.config,
					label: input.existingConnectionApp.label,
					createdAt: input.existingConnectionApp.createdAt,
					updatedAt: now,
				}),
			})
			return { appSlug: input.existingConnectionApp.slug }
		}
	}

	const preferred = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.config.name,
	})
	if (preferred) {
		const connectionCount = await countConnectionsForApp({
			db: input.db,
			userId: input.userId,
			appSlug: preferred.slug,
		})
		// An unfinished setup leaves an app with zero connections. Reuse that
		// slug when the user re-runs setup (or connects) for the same provider
		// key so we do not pile up orphan apps as they edit the client id.
		if (connectionCount === 0) {
			await upsertOauthApp({
				db: input.db,
				row: buildOauthAppRow({
					userId: input.userId,
					slug: preferred.slug,
					config: input.config,
					label: preferred.label,
					createdAt: preferred.createdAt,
					updatedAt: now,
				}),
			})
			return { appSlug: preferred.slug }
		}
	}

	const appSlug = await allocateAppSlug({
		db: input.db,
		userId: input.userId,
		preferredSlug: input.config.name,
	})
	await upsertOauthApp({
		db: input.db,
		row: buildOauthAppRow({
			userId: input.userId,
			slug: appSlug,
			config: input.config,
			label: null,
			createdAt: now,
			updatedAt: now,
		}),
	})
	return { appSlug }
}

function buildOauthAppRow(input: {
	userId: string
	slug: string
	config: OauthAppWriteConfig
	label: string | null
	createdAt: string
	updatedAt: string
}) {
	const provider = providerFromSlug(input.slug)
	const authorization = input.config.authorization ?? null
	const tokenExchangeStyle = input.config.tokenExchangeStyle ?? null
	return {
		user_id: input.userId,
		slug: input.slug,
		provider,
		label: input.label,
		client_id: input.config.clientId,
		token_url: input.config.tokenUrl,
		authorize_url: authorization?.authorizeUrl ?? null,
		device_authorization_url:
			input.config.deviceAuthorizationUrl?.trim() || null,
		api_base_url: input.config.apiBaseUrl ?? null,
		flow: input.config.flow,
		use_pkce:
			typeof input.config.usePkce === 'boolean'
				? input.config.usePkce
					? 1
					: 0
				: null,
		// 'form' is the default exchange style; store NULL so migrated rows and
		// connect-flow writes share one tuple shape.
		token_exchange_style:
			tokenExchangeStyle && tokenExchangeStyle !== 'form'
				? tokenExchangeStyle
				: null,
		scope_separator: authorization?.scopeSeparator ?? null,
		extra_authorize_params_json: JSON.stringify(
			authorization?.extraAuthorizeParams ?? {},
		),
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	}
}

async function allocateAppSlug(input: {
	db: D1Database
	userId: string
	preferredSlug: string
}): Promise<string> {
	const existing = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.preferredSlug,
	})
	if (!existing) return input.preferredSlug
	let suffix = 2
	while (suffix < 10_000) {
		const candidate = `${input.preferredSlug}-${suffix}`
		const conflict = await getOauthAppBySlug({
			db: input.db,
			userId: input.userId,
			slug: candidate,
		})
		if (!conflict) return candidate
		suffix += 1
	}
	throw new Error(
		`Unable to allocate an OAuth app slug for "${input.preferredSlug}".`,
	)
}

export async function setIntegrationUsage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	usageMode: IntegrationUsageMode
	allowedPackageIds?: Array<string>
}): Promise<UserIntegrationConnection | null> {
	const name = canonicalIntegrationName(input.name)
	if (!name) return null
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!existing) return null
	const usageMode = normalizeIntegrationUsageMode(input.usageMode)
	const allowedPackageIds =
		usageMode === 'packages'
			? normalizeAllowedPackages(input.allowedPackageIds ?? [])
			: []
	const updated = await updateIntegrationUsage({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
		usageMode,
		allowedPackageIds,
	})
	if (!updated) return null
	const saved = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	return saved?.connection ?? null
}

export async function grantIntegrationPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	packageId: string
}): Promise<UserIntegrationConnection | null> {
	const name = canonicalIntegrationName(input.name)
	const packageId = input.packageId.trim()
	if (!name || !packageId) return null
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!existing) return null
	if (existing.connection.usageMode === 'any') return existing.connection
	if (existing.connection.allowedPackageIds.includes(packageId)) {
		return existing.connection
	}
	const allowedPackageIds = normalizeAllowedPackages([
		...existing.connection.allowedPackageIds,
		packageId,
	])
	const updated = await updateIntegrationUsage({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
		usageMode: 'packages',
		allowedPackageIds,
	})
	if (!updated) return null
	const saved = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	return saved?.connection ?? null
}

/**
 * Tighten-only usage lock. Switches the connection from any context to
 * packages mode and adds `packageId`. Additional grants accumulate.
 * Unlocking or removing a grant is website-only.
 */
export async function lockIntegrationToPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	packageId: string
}): Promise<UserIntegrationConnection> {
	const name = canonicalIntegrationName(input.name)
	const packageId = input.packageId.trim()
	if (!name) {
		throw new Error('Integration name is required.')
	}
	if (!packageId) {
		throw new Error('Package id is required.')
	}
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!existing) {
		throw new Error(`Integration "${input.name}" was not found.`)
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new Error('Saved package not found for this user.')
	}
	if (
		existing.connection.usageMode === 'packages' &&
		existing.connection.allowedPackageIds.includes(packageId)
	) {
		return existing.connection
	}
	const allowedPackageIds = normalizeAllowedPackages([
		...existing.connection.allowedPackageIds,
		packageId,
	])
	const updated = await updateIntegrationUsage({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
		usageMode: 'packages',
		allowedPackageIds,
	})
	if (!updated) {
		throw new Error(`Unable to lock integration "${name}" to a package.`)
	}
	const saved = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!saved) {
		throw new Error(`Unable to lock integration "${name}" to a package.`)
	}
	return saved.connection
}
