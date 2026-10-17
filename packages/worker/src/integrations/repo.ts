import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import {
	isIntegrationAuthFailureReason,
	type IntegrationAuthFailureReason,
} from '#universal/connection-trouble.ts'
import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from '#mcp/secrets/allowed-packages.ts'
import {
	normalizeIntegrationUsageMode,
	type IntegrationUsageMode,
} from './usage-mode.ts'
import {
	mapPlatformOauthAppRow,
	type PlatformOauthAppRow,
} from './platform-apps.ts'
import {
	isIntegrationRefreshPolicy,
	type IntegrationRefreshPolicy,
} from './refresh-policy.ts'
import { credentialGrantCleanupStatements } from '#worker/credentials/credential-grant-cleanup.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	type JoinedIntegration,
	type UserIntegrationConnection,
	type UserIntegrationRow,
	type UserOauthApp,
	type UserOauthAppRow,
	type UserOauthAppWithConnectionCount,
} from './types.ts'

type NullablePrefixed<TRow, TPrefix extends string> = {
	[Key in keyof TRow & string as `${TPrefix}${Key}`]: TRow[Key] | null
}

type JoinedIntegrationRow = NullablePrefixed<UserOauthAppRow, 'a_'> &
	NullablePrefixed<PlatformOauthAppRow, 'p_'> & {
		user_id: string
		connection_id: string
		connection_name: string
		app_slug: string | null
		platform_app_slug: string | null
		account_label: string | null
		description: string
		scopes_json: string
		required_hosts_json: string
		usage_mode: string | null
		allowed_packages_json: string | null
		connected_at: string | null
		token_refreshed_at: string | null
		auth_failed_at: string | null
		auth_failed_reason: string | null
		auth_failed_provider_error: string | null
		auth_failed_provider_description: string | null
		auth_failed_http_status: number | null
		auth_failed_reconnectable: number | null
		refresh_policy: string | null
		connection_created_at: string
		connection_updated_at: string
	}

type UserOauthAppWithCountRow = UserOauthAppRow & {
	connection_count: number
}

const appSelectColumns = `
	user_id, slug, provider, label, client_id,
	CASE
		WHEN client_secret_encrypted IS NOT NULL
			AND TRIM(client_secret_encrypted) != ''
		THEN 1
		ELSE 0
	END AS has_client_secret,
	token_url, authorize_url, device_authorization_url, api_base_url, flow,
	use_pkce, token_exchange_style, scope_separator, extra_authorize_params_json,
	logo_key, logo_content_type, logo_source, favicon_source_host, created_at,
	updated_at
`

const joinedSelectColumns = `
	i.user_id AS user_id,
	a.user_id AS a_user_id,
	a.slug AS a_slug,
	a.provider AS a_provider,
	a.label AS a_label,
	a.client_id AS a_client_id,
	CASE
		WHEN a.client_secret_encrypted IS NOT NULL
			AND TRIM(a.client_secret_encrypted) != ''
		THEN 1
		ELSE 0
	END AS a_has_client_secret,
	a.token_url AS a_token_url,
	a.authorize_url AS a_authorize_url,
	a.device_authorization_url AS a_device_authorization_url,
	a.api_base_url AS a_api_base_url,
	a.flow AS a_flow,
	a.use_pkce AS a_use_pkce,
	a.token_exchange_style AS a_token_exchange_style,
	a.scope_separator AS a_scope_separator,
	a.extra_authorize_params_json AS a_extra_authorize_params_json,
	a.logo_key AS a_logo_key,
	a.logo_content_type AS a_logo_content_type,
	a.logo_source AS a_logo_source,
	a.favicon_source_host AS a_favicon_source_host,
	a.created_at AS a_created_at,
	a.updated_at AS a_updated_at,
	p.slug AS p_slug,
	p.provider AS p_provider,
	p.label AS p_label,
	p.description AS p_description,
	p.client_id AS p_client_id,
	p.client_secret_encrypted AS p_client_secret_encrypted,
	p.token_url AS p_token_url,
	p.authorize_url AS p_authorize_url,
	p.device_authorization_url AS p_device_authorization_url,
	p.api_base_url AS p_api_base_url,
	p.flow AS p_flow,
	p.use_pkce AS p_use_pkce,
	p.token_exchange_style AS p_token_exchange_style,
	p.scope_separator AS p_scope_separator,
	p.extra_authorize_params_json AS p_extra_authorize_params_json,
	p.allowed_scopes_json AS p_allowed_scopes_json,
	p.default_scopes_json AS p_default_scopes_json,
	p.required_hosts_json AS p_required_hosts_json,
	p.enabled AS p_enabled,
	p.visibility AS p_visibility,
	p.logo_key AS p_logo_key,
	p.logo_content_type AS p_logo_content_type,
	p.created_at AS p_created_at,
	p.updated_at AS p_updated_at,
	i.id AS connection_id,
	i.name AS connection_name,
	i.app_slug AS app_slug,
	i.platform_app_slug AS platform_app_slug,
	i.account_label AS account_label,
	i.description AS description,
	i.scopes_json AS scopes_json,
	i.required_hosts_json AS required_hosts_json,
	i.usage_mode AS usage_mode,
	i.allowed_packages_json AS allowed_packages_json,
	i.connected_at AS connected_at,
	i.token_refreshed_at AS token_refreshed_at,
	i.auth_failed_at AS auth_failed_at,
	i.auth_failed_reason AS auth_failed_reason,
	i.auth_failed_provider_error AS auth_failed_provider_error,
	i.auth_failed_provider_description AS auth_failed_provider_description,
	i.auth_failed_http_status AS auth_failed_http_status,
	i.auth_failed_reconnectable AS auth_failed_reconnectable,
	i.refresh_policy AS refresh_policy,
	i.created_at AS connection_created_at,
	i.updated_at AS connection_updated_at
`

const joinedFromClause = `
	FROM user_integrations i
	LEFT JOIN user_oauth_apps a
		ON a.user_id = i.user_id AND a.slug = i.app_slug${andLiveDeletedAtSql('a')}
	LEFT JOIN platform_oauth_apps p
		ON p.slug = i.platform_app_slug
`

export async function listJoinedIntegrationsForUser(input: {
	db: D1Database
	userId: string
}): Promise<Array<JoinedIntegration>> {
	const result = await input.db
		.prepare(
			`SELECT ${joinedSelectColumns}
			${joinedFromClause}
			WHERE i.user_id = ?${andLiveDeletedAtSql('i')}
			ORDER BY i.name ASC`,
		)
		.bind(input.userId)
		.all<JoinedIntegrationRow>()
	// Skip orphan OAuth/platform joins so one soft-deleted app cannot fail
	// the whole list (search, account UI, waiting probe). Single-get still
	// throws via mapJoinedRow so callers learn the connection is broken.
	const joined: Array<JoinedIntegration> = []
	for (const row of result.results ?? []) {
		if (isOrphanJoinedRow(row)) continue
		joined.push(mapJoinedRow(row))
	}
	return joined
}

export async function getJoinedIntegrationByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<JoinedIntegration | null> {
	const row = await input.db
		.prepare(
			`SELECT ${joinedSelectColumns}
			${joinedFromClause}
			WHERE i.user_id = ? AND i.name = ?${andLiveDeletedAtSql('i')}
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<JoinedIntegrationRow>()
	return row ? mapJoinedRow(row) : null
}

export async function getOauthAppBySlug(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<UserOauthApp | null> {
	const row = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(input.userId, input.slug)
		.first<UserOauthAppRow>()
	return row ? mapOauthAppRow(row) : null
}

export async function listOauthAppsByProvider(input: {
	db: D1Database
	userId: string
	provider: string
}): Promise<Array<UserOauthApp>> {
	const result = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ? AND provider = ?${andLiveDeletedAtSql()}
			ORDER BY slug ASC`,
		)
		.bind(input.userId, input.provider)
		.all<UserOauthAppRow>()
	return (result.results ?? []).map(mapOauthAppRow)
}

export async function findOauthAppByClientCredentials(input: {
	db: D1Database
	userId: string
	clientId: string
}): Promise<UserOauthApp | null> {
	const row = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ?
				AND client_id = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(input.userId, input.clientId)
		.first<UserOauthAppRow>()
	return row ? mapOauthAppRow(row) : null
}

/** Match an app only when the full app-level tuple agrees (not just credentials). */
export async function findOauthAppByAppTuple(input: {
	db: D1Database
	userId: string
	clientId: string
	tokenUrl: string
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	apiBaseUrl: string | null
	flow: UserOauthAppRow['flow']
	usePkce: number | null
	tokenExchangeStyle: UserOauthAppRow['token_exchange_style']
	scopeSeparator: string | null
	extraAuthorizeParamsJson: string
}): Promise<UserOauthApp | null> {
	const row = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ?
				AND client_id = ?
				AND token_url = ?
				AND authorize_url IS ?
				AND device_authorization_url IS ?
				AND api_base_url IS ?
				AND flow = ?
				AND use_pkce IS ?
				AND token_exchange_style IS ?
				AND scope_separator IS ?
				AND extra_authorize_params_json = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(
			input.userId,
			input.clientId,
			input.tokenUrl,
			input.authorizeUrl,
			input.deviceAuthorizationUrl,
			input.apiBaseUrl,
			input.flow,
			input.usePkce,
			input.tokenExchangeStyle,
			input.scopeSeparator,
			input.extraAuthorizeParamsJson,
		)
		.first<UserOauthAppRow>()
	return row ? mapOauthAppRow(row) : null
}

export async function listOauthAppsWithConnectionCounts(input: {
	db: D1Database
	userId: string
}): Promise<Array<UserOauthAppWithConnectionCount>> {
	const result = await input.db
		.prepare(
			`SELECT
				a.user_id, a.slug, a.provider, a.label, a.client_id,
				CASE
					WHEN a.client_secret_encrypted IS NOT NULL
						AND TRIM(a.client_secret_encrypted) != ''
					THEN 1
					ELSE 0
				END AS has_client_secret,
				a.token_url, a.authorize_url, a.device_authorization_url,
				a.api_base_url, a.flow, a.use_pkce, a.token_exchange_style,
				a.scope_separator, a.extra_authorize_params_json,
				a.logo_key, a.logo_content_type, a.logo_source,
				a.favicon_source_host, a.created_at, a.updated_at,
				(
					SELECT count(*)
					FROM user_integrations i
					WHERE i.user_id = a.user_id AND i.app_slug = a.slug
				) AS connection_count
			FROM user_oauth_apps a
			WHERE a.user_id = ?${andLiveDeletedAtSql()}
			ORDER BY a.slug ASC`,
		)
		.bind(input.userId)
		.all<UserOauthAppWithCountRow>()
	return (result.results ?? []).map((row) => ({
		...mapOauthAppRow(row),
		connectionCount: Number(row.connection_count),
	}))
}

export async function countConnectionsForApp(input: {
	db: D1Database
	userId: string
	appSlug: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT count(*) AS count
			FROM user_integrations
			WHERE user_id = ? AND app_slug = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.appSlug)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function upsertOauthApp(input: {
	db: D1Database
	row: Omit<
		UserOauthAppRow,
		| 'created_at'
		| 'updated_at'
		| 'logo_key'
		| 'logo_content_type'
		| 'logo_source'
		| 'favicon_source_host'
	> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, label, client_id,
				token_url, authorize_url, device_authorization_url, api_base_url,
				flow, use_pkce, token_exchange_style, scope_separator,
				extra_authorize_params_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, slug)
			DO UPDATE SET
				provider = excluded.provider,
				label = excluded.label,
				client_id = excluded.client_id,
				token_url = excluded.token_url,
				authorize_url = excluded.authorize_url,
				device_authorization_url = excluded.device_authorization_url,
				api_base_url = excluded.api_base_url,
				flow = excluded.flow,
				use_pkce = excluded.use_pkce,
				token_exchange_style = excluded.token_exchange_style,
				scope_separator = excluded.scope_separator,
				extra_authorize_params_json = excluded.extra_authorize_params_json,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.user_id,
			input.row.slug,
			input.row.provider,
			input.row.label,
			input.row.client_id,
			input.row.token_url,
			input.row.authorize_url,
			input.row.device_authorization_url,
			input.row.api_base_url,
			input.row.flow,
			input.row.use_pkce,
			input.row.token_exchange_style,
			input.row.scope_separator,
			input.row.extra_authorize_params_json,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function updateOauthAppClientCredentials(input: {
	db: D1Database
	userId: string
	slug: string
	clientId: string
	updatedAt?: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE user_oauth_apps
			SET client_id = ?,
				updated_at = ?
			WHERE user_id = ? AND slug = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.clientId,
			input.updatedAt ?? new Date().toISOString(),
			input.userId,
			input.slug,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteOauthApp(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM user_oauth_apps
			WHERE user_id = ? AND slug = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.slug)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function upsertIntegrationConnection(input: {
	db: D1Database
	row: Omit<UserIntegrationRow, 'id' | 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, platform_app_slug, account_label, description,
				scopes_json, required_hosts_json, connected_at, token_refreshed_at,
				created_at, updated_at, provider
			) VALUES (
				?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
				COALESCE(
					(SELECT provider FROM platform_oauth_apps WHERE slug = ?4),
					(SELECT provider FROM user_oauth_apps WHERE user_id = ?1 AND slug = ?3)
				)
			)
			ON CONFLICT(user_id, name)
			DO UPDATE SET
				app_slug = excluded.app_slug,
				platform_app_slug = excluded.platform_app_slug,
				provider = excluded.provider,
				account_label = excluded.account_label,
				description = excluded.description,
				scopes_json = excluded.scopes_json,
				required_hosts_json = excluded.required_hosts_json,
				connected_at = excluded.connected_at,
				token_refreshed_at = excluded.token_refreshed_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.user_id,
			input.row.name,
			input.row.app_slug,
			input.row.platform_app_slug,
			input.row.account_label,
			input.row.description,
			input.row.scopes_json,
			input.row.required_hosts_json,
			input.row.connected_at,
			input.row.token_refreshed_at,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function addPlatformIntegrationRequiredHosts(input: {
	db: D1Database
	userId: string
	name: string
	hosts: Array<string>
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE user_integrations
			SET required_hosts_json = (
				SELECT json_group_array(host)
				FROM (
					SELECT value AS host
					FROM json_each(user_integrations.required_hosts_json)
					UNION
					SELECT value AS host
					FROM json_each(?)
					ORDER BY host
				)
			)
			WHERE user_id = ? AND name = ? AND platform_app_slug IS NOT NULL${andLiveDeletedAtSql()}`,
		)
		.bind(JSON.stringify(input.hosts), input.userId, input.name)
		.run()
}

export async function deleteIntegrationConnection(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<boolean> {
	const liveRowSql = `FROM user_integrations
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}`
	const results = await input.db.batch([
		...credentialGrantCleanupStatements(input.db, {
			ownerId: input.userId,
			credentialIdSql: `SELECT id ${liveRowSql}`,
			credentialIdBindings: [input.userId, input.name],
		}),
		input.db.prepare(`DELETE ${liveRowSql}`).bind(input.userId, input.name),
	])
	return (results.at(-1)?.meta.changes ?? 0) > 0
}

export async function getIntegrationCredentialId(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<string | null> {
	const row = await input.db
		.prepare(
			`SELECT id FROM user_integrations
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<{ id: string }>()
	return row?.id ?? null
}

export async function getIntegrationCredentialCiphertexts(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<{
	credentialId: string
	accessTokenEncrypted: string | null
	refreshTokenEncrypted: string | null
} | null> {
	const row = await input.db
		.prepare(
			`SELECT id, access_token_encrypted, refresh_token_encrypted
			FROM user_integrations
			WHERE user_id = ? AND name = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<{
			id: string
			access_token_encrypted: string | null
			refresh_token_encrypted: string | null
		}>()
	if (!row) return null
	return {
		credentialId: row.id,
		accessTokenEncrypted: row.access_token_encrypted,
		refreshTokenEncrypted: row.refresh_token_encrypted,
	}
}

export async function updateIntegrationCredentialCiphertexts(input: {
	db: D1Database
	userId: string
	name: string
	accessTokenEncrypted: string
	refreshTokenEncrypted: string | null
	refreshPolicy: IntegrationRefreshPolicy
	/** When set, the write only lands while this refresh lease is still held. */
	refreshLeaseId?: string
}): Promise<{ written: boolean }> {
	const now = new Date().toISOString()
	const leaseFence =
		input.refreshLeaseId === undefined ? '' : ' AND token_refresh_lease_id = ?'
	// Stamp connected_at on first successful token write (user-lane OAuth
	// connect used to leave it null). COALESCE keeps the original connect
	// time across refreshes and reconnect token rotates.
	const result = await input.db
		.prepare(
			`UPDATE user_integrations
			SET access_token_encrypted = ?,
				refresh_token_encrypted = COALESCE(?, refresh_token_encrypted),
				refresh_policy = ?,
				connected_at = COALESCE(connected_at, ?),
				updated_at = ?
			WHERE user_id = ? AND name = ?${leaseFence}${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.accessTokenEncrypted,
			input.refreshTokenEncrypted,
			input.refreshPolicy,
			now,
			now,
			input.userId,
			input.name,
			...(input.refreshLeaseId === undefined ? [] : [input.refreshLeaseId]),
		)
		.run()
	return { written: result.meta.changes > 0 }
}

export async function getOauthAppClientSecretCiphertext(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<string | null> {
	const row = await input.db
		.prepare(
			`SELECT client_secret_encrypted
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.slug)
		.first<{ client_secret_encrypted: string | null }>()
	return row?.client_secret_encrypted ?? null
}

export async function updateOauthAppClientSecretCiphertext(input: {
	db: D1Database
	userId: string
	slug: string
	clientSecretEncrypted: string
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`UPDATE user_oauth_apps
			SET client_secret_encrypted = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.clientSecretEncrypted, now, input.userId, input.slug)
		.run()
}

export async function updateIntegrationUsage(input: {
	db: D1Database
	userId: string
	name: string
	usageMode: IntegrationUsageMode
	allowedPackageIds: Array<string>
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE user_integrations
			SET usage_mode = ?,
				allowed_packages_json = ?,
				updated_at = ?
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.usageMode,
			stringifyAllowedPackages(input.allowedPackageIds),
			now,
			input.userId,
			input.name,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export function mapOauthAppRow(row: UserOauthAppRow): UserOauthApp {
	return {
		userId: row.user_id,
		slug: row.slug,
		provider: row.provider,
		label: row.label,
		clientId: row.client_id,
		hasClientSecret: row.has_client_secret === 1,
		tokenUrl: row.token_url,
		authorizeUrl: row.authorize_url,
		deviceAuthorizationUrl: row.device_authorization_url ?? null,
		apiBaseUrl: row.api_base_url,
		flow: row.flow,
		usePkce: row.use_pkce == null ? null : row.use_pkce === 1,
		tokenExchangeStyle: row.token_exchange_style,
		scopeSeparator: row.scope_separator,
		extraAuthorizeParams: parseJsonObject(row.extra_authorize_params_json),
		logoKey: row.logo_key ?? null,
		logoContentType: row.logo_content_type ?? null,
		logoSource: row.logo_source ?? null,
		faviconSourceHost: row.favicon_source_host ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function mapIntegrationRow(
	row: UserIntegrationRow,
): UserIntegrationConnection {
	const refreshPolicy = isIntegrationRefreshPolicy(row.refresh_policy)
		? row.refresh_policy
		: null
	return {
		credentialId: row.id,
		userId: row.user_id,
		name: row.name,
		appSlug: row.app_slug,
		platformAppSlug: row.platform_app_slug,
		accountLabel: row.account_label,
		description: row.description,
		scopes: parseJsonStringArray(row.scopes_json),
		requiredHosts: parseJsonStringArray(row.required_hosts_json),
		usageMode: normalizeIntegrationUsageMode(row.usage_mode),
		allowedPackageIds: parseAllowedPackages(row.allowed_packages_json),
		connectedAt: row.connected_at,
		tokenRefreshedAt: row.token_refreshed_at,
		lastAuthFailure: mapLastAuthFailure(row, refreshPolicy),
		refreshPolicy,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export async function writeIntegrationAuthFailure(input: {
	db: D1Database
	userId: string
	name: string
	reason: IntegrationAuthFailureReason
	providerError?: string | null
	providerErrorDescription?: string | null
	httpStatus?: number | null
	reconnectable: boolean
	/**
	 * Snapshot from the refresh that is failing. `IS` is NULL-safe so a
	 * concurrent winner that already advanced `token_refreshed_at` (and
	 * cleared health) is not overwritten by a loser `invalid_grant`.
	 */
	expectedTokenRefreshedAt: string | null
	occurredAt?: string
}): Promise<void> {
	const now = input.occurredAt ?? new Date().toISOString()
	await input.db
		.prepare(
			`UPDATE user_integrations
			SET auth_failed_at = ?,
				auth_failed_reason = ?,
				auth_failed_provider_error = ?,
				auth_failed_provider_description = ?,
				auth_failed_http_status = ?,
				auth_failed_reconnectable = ?,
				updated_at = ?
			WHERE user_id = ? AND name = ? AND token_refreshed_at IS ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			now,
			input.reason,
			input.providerError ?? null,
			input.providerErrorDescription ?? null,
			input.httpStatus ?? null,
			input.reconnectable ? 1 : 0,
			now,
			input.userId,
			input.name,
			input.expectedTokenRefreshedAt,
		)
		.run()
}

export async function clearIntegrationAuthFailure(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`UPDATE user_integrations
			SET auth_failed_at = NULL,
				auth_failed_reason = NULL,
				auth_failed_provider_error = NULL,
				auth_failed_provider_description = NULL,
				auth_failed_http_status = NULL,
				auth_failed_reconnectable = NULL,
				updated_at = ?
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}`,
		)
		.bind(now, input.userId, input.name)
		.run()
}

export type IntegrationTokenRefreshLeaseClaim =
	| { status: 'claimed' }
	| { status: 'held' }
	| { status: 'refreshed'; tokenRefreshedAt: string }
	| { status: 'stale' }
	| { status: 'missing' }

/**
 * Claims the per-connection refresh lease only while `token_refreshed_at` still
 * matches what the caller observed and no unexpired lease is held. When the
 * claim fails, the re-read tells the caller whether another writer already
 * refreshed (use the stored token), the connection was replaced since the
 * caller read it (`stale`: re-read and start over), or a lease is still held
 * (wait).
 */
export async function claimIntegrationTokenRefreshLease(input: {
	db: D1Database
	userId: string
	name: string
	leaseId: string
	expectedTokenRefreshedAt: string | null
	now: Date
	leaseMs: number
}): Promise<IntegrationTokenRefreshLeaseClaim> {
	const nowIso = input.now.toISOString()
	const expiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString()
	const claim = await input.db
		.prepare(
			`UPDATE user_integrations
			SET token_refresh_lease_id = ?,
				token_refresh_lease_expires_at = ?
			WHERE user_id = ? AND name = ?
				AND token_refreshed_at IS ?
				AND (
					token_refresh_lease_expires_at IS NULL
					OR token_refresh_lease_expires_at <= ?
				)${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.leaseId,
			expiresAt,
			input.userId,
			input.name,
			input.expectedTokenRefreshedAt,
			nowIso,
		)
		.run()
	if (claim.meta.changes === 1) return { status: 'claimed' }
	const row = await input.db
		.prepare(
			`SELECT token_refreshed_at
			FROM user_integrations
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<{ token_refreshed_at: string | null }>()
	if (!row) return { status: 'missing' }
	if (row.token_refreshed_at === input.expectedTokenRefreshedAt) {
		return { status: 'held' }
	}
	if (row.token_refreshed_at === null) return { status: 'stale' }
	return { status: 'refreshed', tokenRefreshedAt: row.token_refreshed_at }
}

export async function releaseIntegrationTokenRefreshLease(input: {
	db: D1Database
	userId: string
	name: string
	leaseId: string
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE user_integrations
			SET token_refresh_lease_id = NULL,
				token_refresh_lease_expires_at = NULL
			WHERE user_id = ? AND name = ? AND token_refresh_lease_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.name, input.leaseId)
		.run()
}

function mapLastAuthFailure(
	row: {
		auth_failed_at?: string | null
		auth_failed_reason?: string | null
		auth_failed_provider_error?: string | null
		auth_failed_provider_description?: string | null
		auth_failed_http_status?: number | null
		auth_failed_reconnectable?: number | null
	},
	refreshPolicy: IntegrationRefreshPolicy | null,
) {
	const occurredAt = row.auth_failed_at?.trim() ?? ''
	const reason = row.auth_failed_reason?.trim() ?? ''
	if (!occurredAt || !isIntegrationAuthFailureReason(reason)) return null
	// A non-expiring grant is healthy without a refresh token, so a stale
	// snapshot from before the policy was known must not surface as trouble.
	if (
		reason === 'missing_refresh_token' &&
		refreshPolicy === 'not_applicable'
	) {
		return null
	}
	return {
		occurredAt,
		reason,
		providerError: row.auth_failed_provider_error ?? null,
		providerErrorDescription: row.auth_failed_provider_description ?? null,
		httpStatus:
			row.auth_failed_http_status == null
				? null
				: Number(row.auth_failed_http_status),
		reconnectable: row.auth_failed_reconnectable === 1,
	}
}

/**
 * True when the connection row cannot join a live OAuth (user or platform) app.
 * List callers skip these; single-get still throws in {@link mapJoinedRow}.
 */
function isOrphanJoinedRow(row: JoinedIntegrationRow): boolean {
	if (row.platform_app_slug != null) {
		return row.p_slug == null
	}
	return row.app_slug == null || row.a_slug == null
}

function mapJoinedRow(row: JoinedIntegrationRow): JoinedIntegration {
	const connection = mapIntegrationRow({
		id: row.connection_id,
		user_id: row.user_id,
		name: row.connection_name,
		app_slug: row.app_slug,
		platform_app_slug: row.platform_app_slug,
		account_label: row.account_label,
		description: row.description,
		scopes_json: row.scopes_json,
		required_hosts_json: row.required_hosts_json,
		usage_mode: normalizeIntegrationUsageMode(row.usage_mode),
		allowed_packages_json: row.allowed_packages_json ?? '[]',
		connected_at: row.connected_at,
		token_refreshed_at: row.token_refreshed_at,
		auth_failed_at: row.auth_failed_at,
		auth_failed_reason: row.auth_failed_reason,
		auth_failed_provider_error: row.auth_failed_provider_error,
		auth_failed_provider_description: row.auth_failed_provider_description,
		auth_failed_http_status: row.auth_failed_http_status,
		auth_failed_reconnectable: row.auth_failed_reconnectable,
		refresh_policy: row.refresh_policy,
		created_at: row.connection_created_at,
		updated_at: row.connection_updated_at,
	})
	if (row.platform_app_slug != null && row.p_slug != null) {
		return {
			lane: 'platform',
			app: mapPlatformOauthAppRow({
				slug: row.p_slug,
				provider: row.p_provider ?? row.p_slug,
				label: row.p_label,
				description: row.p_description ?? null,
				client_id: row.p_client_id ?? '',
				client_secret_encrypted: row.p_client_secret_encrypted,
				token_url: row.p_token_url ?? '',
				authorize_url: row.p_authorize_url ?? '',
				device_authorization_url: row.p_device_authorization_url ?? null,
				api_base_url: row.p_api_base_url,
				flow: row.p_flow ?? 'pkce',
				use_pkce: row.p_use_pkce,
				token_exchange_style: row.p_token_exchange_style,
				scope_separator: row.p_scope_separator,
				extra_authorize_params_json: row.p_extra_authorize_params_json ?? '{}',
				allowed_scopes_json: row.p_allowed_scopes_json ?? '[]',
				default_scopes_json: row.p_default_scopes_json ?? '[]',
				required_hosts_json: row.p_required_hosts_json ?? '[]',
				enabled: row.p_enabled ?? 0,
				visibility: row.p_visibility ?? 'draft',
				logo_key: row.p_logo_key ?? null,
				logo_content_type: row.p_logo_content_type ?? null,
				created_at: row.p_created_at ?? '',
				updated_at: row.p_updated_at ?? '',
			}),
			connection,
		}
	}
	if (row.app_slug == null || row.a_slug == null) {
		throw new Error(
			`Integration "${row.connection_name}" references a missing OAuth app.`,
		)
	}
	return {
		lane: 'user',
		app: mapOauthAppRow({
			user_id: row.a_user_id ?? row.user_id,
			slug: row.a_slug,
			provider: row.a_provider ?? row.a_slug,
			label: row.a_label,
			client_id: row.a_client_id ?? '',
			has_client_secret: row.a_has_client_secret,
			token_url: row.a_token_url ?? '',
			authorize_url: row.a_authorize_url,
			device_authorization_url: row.a_device_authorization_url ?? null,
			api_base_url: row.a_api_base_url,
			flow: row.a_flow ?? 'pkce',
			use_pkce: row.a_use_pkce,
			token_exchange_style: row.a_token_exchange_style,
			scope_separator: row.a_scope_separator,
			extra_authorize_params_json: row.a_extra_authorize_params_json ?? '{}',
			logo_key: row.a_logo_key ?? null,
			logo_content_type: row.a_logo_content_type ?? null,
			logo_source: row.a_logo_source ?? null,
			favicon_source_host: row.a_favicon_source_host ?? null,
			created_at: row.a_created_at ?? '',
			updated_at: row.a_updated_at ?? '',
		}),
		connection,
	}
}

function parseJsonObject(raw: string): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		const result: Record<string, string> = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string') result[key] = value
		}
		return result
	} catch {
		return {}
	}
}
