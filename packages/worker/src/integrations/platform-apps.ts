import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import {
	decryptPlatformOauthClientSecret,
	encryptPlatformOauthClientSecret,
	platformOauthAppContext,
} from '#mcp/secrets/crypto.ts'
import {
	canonicalIntegrationName,
	type integrationFlowValues,
	type tokenExchangeStyleValues,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { assertSafeDeviceAuthorizationUrl } from './device-flow.ts'
import { providerFromSlug } from './provider-from-slug.ts'

/**
 * Operator-fixable input rejection while saving a platform OAuth app
 * (missing required fields, enabling a confidential app without a secret).
 * MCP capabilities re-wrap this as `McpCallerError` so agent staging mistakes
 * stay on `mcp-event` lines and out of Sentry.
 */
export class PlatformOauthAppValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PlatformOauthAppValidationError'
	}
}

export const platformOauthAppVisibilityValues = ['draft', 'published'] as const

/**
 * Catalog visibility, independent of `enabled`. Only apps that are both
 * enabled and published are discoverable: offered on onboarding, account
 * integrations, and the /connect/oauth chooser, and accepted for new
 * connects. Draft apps stay hidden but keep serving existing connections.
 */
export type PlatformOauthAppVisibility =
	(typeof platformOauthAppVisibilityValues)[number]

/**
 * Operator-provisioned built-in OAuth apps shared across every user.
 *
 * The client secret is stored encrypted in `platform_oauth_apps` and is
 * deliberately outside the user secret store: no `{{secret:...}}` placeholder
 * can reference it, so sandboxed code has no resolution path to the shared
 * credential. `getPlatformOauthAppClientSecret` is the only decrypt accessor;
 * its callers are host-side token-exchange paths (the /connect/oauth exchange
 * for discoverable apps and `integrationTokenRefresh`). Never expose the
 * decrypted value in capability outputs, loader payloads, or logs.
 */
export type PlatformOauthApp = {
	slug: string
	provider: string
	label: string | null
	/** Operator-authored note (limitations, scope caveats) shown pre-connect. */
	description: string | null
	clientId: string
	hasClientSecret: boolean
	tokenUrl: string
	authorizeUrl: string
	deviceAuthorizationUrl: string | null
	apiBaseUrl: string | null
	flow: (typeof integrationFlowValues)[number]
	usePkce: boolean | null
	tokenExchangeStyle: (typeof tokenExchangeStyleValues)[number] | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	allowedScopes: Array<string>
	defaultScopes: Array<string>
	requiredHosts: Array<string>
	enabled: boolean
	visibility: PlatformOauthAppVisibility
	/** R2 key of the operator-uploaded logo asset, or null. */
	logoKey: string | null
	logoContentType: string | null
	createdAt: string
	updatedAt: string
}

export type PlatformOauthAppRow = {
	slug: string
	provider: string
	label: string | null
	description: string | null
	client_id: string
	client_secret_encrypted: string | null
	token_url: string
	authorize_url: string
	device_authorization_url: string | null
	api_base_url: string | null
	flow: (typeof integrationFlowValues)[number]
	use_pkce: number | null
	token_exchange_style: (typeof tokenExchangeStyleValues)[number] | null
	scope_separator: string | null
	extra_authorize_params_json: string
	allowed_scopes_json: string
	default_scopes_json: string
	required_hosts_json: string
	enabled: number
	visibility: PlatformOauthAppVisibility
	logo_key: string | null
	logo_content_type: string | null
	created_at: string
	updated_at: string
}

const platformAppSelectColumns = `
	slug, provider, label, description, client_id, client_secret_encrypted,
	token_url, authorize_url, device_authorization_url, api_base_url, flow,
	use_pkce, token_exchange_style, scope_separator, extra_authorize_params_json,
	allowed_scopes_json, default_scopes_json, required_hosts_json, enabled,
	visibility, logo_key, logo_content_type, created_at, updated_at
`

const discoverableWhereClause = `enabled = 1 AND visibility = 'published'`

export async function listPlatformOauthApps(input: {
	db: D1Database
	includeDisabled?: boolean
}): Promise<Array<PlatformOauthApp>> {
	const statement = input.includeDisabled
		? `SELECT ${platformAppSelectColumns} FROM platform_oauth_apps ORDER BY slug ASC`
		: `SELECT ${platformAppSelectColumns} FROM platform_oauth_apps WHERE enabled = 1 ORDER BY slug ASC`
	const result = await input.db.prepare(statement).all<PlatformOauthAppRow>()
	return (result.results ?? []).map(mapPlatformOauthAppRow)
}

export function isPlatformOauthAppDiscoverable(
	app: Pick<PlatformOauthApp, 'enabled' | 'visibility'>,
): boolean {
	return app.enabled && app.visibility === 'published'
}

/** Enabled + published apps: the only ones discovery surfaces may offer. */
export async function listDiscoverablePlatformOauthApps(input: {
	db: D1Database
}): Promise<Array<PlatformOauthApp>> {
	const result = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns} FROM platform_oauth_apps
			WHERE ${discoverableWhereClause}
			ORDER BY slug ASC`,
		)
		.all<PlatformOauthAppRow>()
	return (result.results ?? []).map(mapPlatformOauthAppRow)
}

/**
 * The enabled + published app for `slug`, or null. New platform-lane
 * connects (connect_oauth / oauth_exchange) resolve through this so a draft
 * app never accepts a connect even when a caller knows its slug.
 */
export async function getDiscoverablePlatformOauthApp(input: {
	db: D1Database
	slug: string
}): Promise<PlatformOauthApp | null> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return null
	const row = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns}
			FROM platform_oauth_apps
			WHERE slug = ? AND ${discoverableWhereClause}
			LIMIT 1`,
		)
		.bind(slug)
		.first<PlatformOauthAppRow>()
	return row ? mapPlatformOauthAppRow(row) : null
}

export async function getPlatformOauthAppBySlug(input: {
	db: D1Database
	slug: string
	includeDisabled?: boolean
}): Promise<PlatformOauthApp | null> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return null
	const row = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns}
			FROM platform_oauth_apps
			WHERE slug = ?${input.includeDisabled ? '' : ' AND enabled = 1'}
			LIMIT 1`,
		)
		.bind(slug)
		.first<PlatformOauthAppRow>()
	return row ? mapPlatformOauthAppRow(row) : null
}

/**
 * Every optional field is retain-on-omit: `undefined` keeps the stored value
 * on update, so a partial admin save can never silently clear the scope menu,
 * required hosts, or the stored client secret. Pass `null` (or an empty
 * array/record) to clear a field explicitly.
 */
export type PlatformOauthAppSaveInput = {
	slug: string
	provider?: string | null
	label?: string | null
	description?: string | null
	clientId: string
	/**
	 * Plaintext client secret to encrypt and store. `undefined` keeps the
	 * currently stored ciphertext; `null` clears it (public PKCE apps).
	 */
	clientSecret?: string | null
	tokenUrl: string
	authorizeUrl: string
	deviceAuthorizationUrl?: string | null
	apiBaseUrl?: string | null
	flow: (typeof integrationFlowValues)[number]
	usePkce?: boolean | null
	tokenExchangeStyle?: (typeof tokenExchangeStyleValues)[number] | null
	scopeSeparator?: string | null
	extraAuthorizeParams?: Record<string, string>
	allowedScopes?: Array<string>
	defaultScopes?: Array<string>
	requiredHosts?: Array<string>
	enabled?: boolean
	/** Defaults to draft on create; omit to keep the stored value. */
	visibility?: PlatformOauthAppVisibility
}

export async function upsertPlatformOauthApp(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	app: PlatformOauthAppSaveInput
}): Promise<PlatformOauthApp> {
	const slug = canonicalIntegrationName(input.app.slug)
	if (!slug) {
		throw new PlatformOauthAppValidationError(
			'Platform app slug must contain letters or numbers.',
		)
	}
	const clientId = input.app.clientId.trim()
	if (!clientId) {
		throw new PlatformOauthAppValidationError('Client id is required.')
	}
	const tokenUrl = input.app.tokenUrl.trim()
	const authorizeUrl = input.app.authorizeUrl.trim()
	if (!tokenUrl) {
		throw new PlatformOauthAppValidationError('Token URL is required.')
	}
	const existing = await getPlatformOauthAppRowBySlug({ db: input.db, slug })
	const deviceAuthorizationUrl =
		input.app.deviceAuthorizationUrl === undefined
			? (existing?.device_authorization_url ?? null)
			: input.app.deviceAuthorizationUrl?.trim() || null
	switch (input.app.flow) {
		case 'device': {
			const deviceUrlError = assertSafeDeviceAuthorizationUrl(
				deviceAuthorizationUrl ?? '',
			)
			if (deviceUrlError) {
				throw new PlatformOauthAppValidationError(deviceUrlError)
			}
			break
		}
		case 'pkce':
		case 'confidential': {
			if (!authorizeUrl) {
				throw new PlatformOauthAppValidationError('Authorize URL is required.')
			}
			break
		}
		default: {
			const exhaustiveCheck: never = input.app.flow
			throw new PlatformOauthAppValidationError(
				`Unhandled OAuth flow: ${String(exhaustiveCheck)}`,
			)
		}
	}

	const clientSecretEncrypted =
		input.app.clientSecret === undefined
			? (existing?.client_secret_encrypted ?? null)
			: input.app.clientSecret === null || input.app.clientSecret.trim() === ''
				? null
				: await encryptPlatformOauthClientSecret(
						input.env,
						input.app.clientSecret.trim(),
						platformOauthAppContext(slug),
					)
	const enabled =
		input.app.enabled === undefined
			? (existing?.enabled ?? 1)
			: input.app.enabled
				? 1
				: 0
	// Disabled apps may omit credentials so an agent can stage the full
	// provider config through MCP and an operator pastes credentials (and
	// enables) later. Confidential flow requires a client secret once
	// enabled; device flow allows public (no-secret) clients.
	if (enabled && input.app.flow === 'confidential' && !clientSecretEncrypted) {
		throw new PlatformOauthAppValidationError(
			'Confidential flow requires a client secret before the app can be enabled. Save it with enabled: false to stage the config first.',
		)
	}

	const visibility =
		input.app.visibility ?? existing?.visibility ?? ('draft' as const)

	const now = new Date().toISOString()
	const defaultScopes =
		input.app.defaultScopes === undefined
			? parseJsonStringArray(existing?.default_scopes_json ?? '[]')
			: normalizeScopes(input.app.defaultScopes)
	const allowedScopes = normalizeScopes([
		...(input.app.allowedScopes === undefined
			? parseJsonStringArray(existing?.allowed_scopes_json ?? '[]')
			: input.app.allowedScopes),
		...defaultScopes,
	])
	const usePkce =
		input.app.usePkce === undefined
			? (existing?.use_pkce ?? null)
			: input.app.usePkce == null
				? null
				: input.app.usePkce
					? 1
					: 0
	await input.db
		.prepare(
			`INSERT INTO platform_oauth_apps (
				slug, provider, label, description, client_id,
				client_secret_encrypted, token_url, authorize_url,
				device_authorization_url, api_base_url, flow, use_pkce,
				token_exchange_style, scope_separator,
				extra_authorize_params_json, allowed_scopes_json,
				default_scopes_json, required_hosts_json, enabled, visibility,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(slug)
			DO UPDATE SET
				provider = excluded.provider,
				label = excluded.label,
				description = excluded.description,
				client_id = excluded.client_id,
				client_secret_encrypted = excluded.client_secret_encrypted,
				token_url = excluded.token_url,
				authorize_url = excluded.authorize_url,
				device_authorization_url = excluded.device_authorization_url,
				api_base_url = excluded.api_base_url,
				flow = excluded.flow,
				use_pkce = excluded.use_pkce,
				token_exchange_style = excluded.token_exchange_style,
				scope_separator = excluded.scope_separator,
				extra_authorize_params_json = excluded.extra_authorize_params_json,
				allowed_scopes_json = excluded.allowed_scopes_json,
				default_scopes_json = excluded.default_scopes_json,
				required_hosts_json = excluded.required_hosts_json,
				enabled = excluded.enabled,
				visibility = excluded.visibility,
				updated_at = excluded.updated_at`,
		)
		.bind(
			slug,
			input.app.provider === undefined
				? (existing?.provider ?? providerFromSlug(slug))
				: input.app.provider?.trim() || providerFromSlug(slug),
			input.app.label === undefined
				? (existing?.label ?? null)
				: input.app.label?.trim() || null,
			input.app.description === undefined
				? (existing?.description ?? null)
				: input.app.description?.trim() || null,
			clientId,
			clientSecretEncrypted,
			tokenUrl,
			authorizeUrl,
			deviceAuthorizationUrl,
			input.app.apiBaseUrl === undefined
				? (existing?.api_base_url ?? null)
				: input.app.apiBaseUrl?.trim() || null,
			input.app.flow,
			usePkce,
			input.app.tokenExchangeStyle === undefined
				? (existing?.token_exchange_style ?? null)
				: (input.app.tokenExchangeStyle ?? null),
			input.app.scopeSeparator === undefined
				? (existing?.scope_separator ?? null)
				: (input.app.scopeSeparator ?? null),
			input.app.extraAuthorizeParams === undefined
				? (existing?.extra_authorize_params_json ?? '{}')
				: JSON.stringify(input.app.extraAuthorizeParams),
			JSON.stringify(allowedScopes),
			JSON.stringify(defaultScopes),
			input.app.requiredHosts === undefined
				? (existing?.required_hosts_json ?? '[]')
				: JSON.stringify(input.app.requiredHosts),
			enabled,
			visibility,
			existing?.created_at ?? now,
			now,
		)
		.run()

	const saved = await getPlatformOauthAppBySlug({
		db: input.db,
		slug,
		includeDisabled: true,
	})
	if (!saved) {
		throw new Error(`Failed to save platform OAuth app "${slug}".`)
	}
	return saved
}

/**
 * Renames a platform app slug in place, carrying every column (including the
 * encrypted client secret and logo key — both write-only through every other
 * surface) and moving user connections atomically. Connection *names* stay
 * untouched: only the `platform_app_slug` reference moves, so tokens keep
 * working without any user action. The insert → move children → delete-old
 * sequence keeps the `user_integrations.platform_app_slug` foreign key
 * satisfied at every statement, and `db.batch` makes it atomic.
 */
export async function renamePlatformOauthApp(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	slug: string
	newSlug: string
}): Promise<PlatformOauthApp> {
	const slug = canonicalIntegrationName(input.slug)
	const newSlug = canonicalIntegrationName(input.newSlug)
	if (!slug || !newSlug) {
		throw new PlatformOauthAppValidationError(
			'Platform app slugs must contain letters or numbers.',
		)
	}
	if (slug === newSlug) {
		throw new PlatformOauthAppValidationError(
			'New slug matches the current slug.',
		)
	}
	const existing = await getPlatformOauthAppBySlug({
		db: input.db,
		slug,
		includeDisabled: true,
	})
	if (!existing) {
		throw new PlatformOauthAppValidationError(
			`Platform OAuth app "${slug}" was not found.`,
		)
	}
	const collision = await getPlatformOauthAppBySlug({
		db: input.db,
		slug: newSlug,
		includeDisabled: true,
	})
	if (collision) {
		throw new PlatformOauthAppValidationError(
			`Platform OAuth app "${newSlug}" already exists.`,
		)
	}
	// The ciphertext is AAD-bound to the app slug, so a carried secret must be
	// re-encrypted under the new slug's context.
	const secretRow = await getPlatformOauthAppRowBySlug({ db: input.db, slug })
	const reboundSecret = secretRow?.client_secret_encrypted
		? await encryptPlatformOauthClientSecret(
				input.env,
				await decryptPlatformOauthClientSecret(
					input.env,
					secretRow.client_secret_encrypted,
					platformOauthAppContext(slug),
				),
				platformOauthAppContext(newSlug),
			)
		: null
	await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO platform_oauth_apps (
					slug, provider, label, description, client_id,
					client_secret_encrypted, token_url, authorize_url,
					device_authorization_url, api_base_url, flow, use_pkce,
					token_exchange_style, scope_separator,
					extra_authorize_params_json, allowed_scopes_json,
					default_scopes_json, required_hosts_json, enabled, visibility,
					logo_key, logo_content_type, created_at, updated_at
				)
				SELECT
					?, provider, label, description, client_id,
					?, token_url, authorize_url, device_authorization_url,
					api_base_url, flow, use_pkce, token_exchange_style,
					scope_separator, extra_authorize_params_json,
					allowed_scopes_json, default_scopes_json, required_hosts_json,
					enabled, visibility, logo_key, logo_content_type, created_at, ?
				FROM platform_oauth_apps WHERE slug = ?`,
			)
			.bind(newSlug, reboundSecret, new Date().toISOString(), slug),
		input.db
			.prepare(
				`UPDATE user_integrations SET platform_app_slug = ?
				WHERE platform_app_slug = ?${andLiveDeletedAtSql()}`,
			)
			.bind(newSlug, slug),
		input.db
			.prepare(`DELETE FROM platform_oauth_apps WHERE slug = ?`)
			.bind(slug),
	])
	const renamed = await getPlatformOauthAppBySlug({
		db: input.db,
		slug: newSlug,
		includeDisabled: true,
	})
	if (!renamed) {
		throw new Error(`Failed to rename platform OAuth app "${slug}".`)
	}
	return renamed
}

export async function deletePlatformOauthApp(input: {
	db: D1Database
	slug: string
}): Promise<boolean> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return false
	const connectionCount = await countConnectionsForPlatformApp({
		db: input.db,
		slug,
	})
	if (connectionCount > 0) {
		throw new Error(
			`Platform OAuth app "${slug}" still has ${connectionCount} user connection${connectionCount === 1 ? '' : 's'}. Disable it instead of deleting.`,
		)
	}
	const result = await input.db
		.prepare(`DELETE FROM platform_oauth_apps WHERE slug = ?`)
		.bind(slug)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function countConnectionsForPlatformApp(input: {
	db: D1Database
	slug: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT count(*) AS count
			FROM user_integrations
			WHERE platform_app_slug = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.slug)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * Decrypts the shared client secret for host-side token exchange. This is the
 * only decrypt path; keep its callers limited to the connect-flow exchange and
 * the `integrationTokenRefresh` capability, and never place the returned
 * value in a response, capability output, or log.
 */
export async function getPlatformOauthAppClientSecret(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	slug: string
}): Promise<string | null> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return null
	const row = await getPlatformOauthAppRowBySlug({ db: input.db, slug })
	if (!row?.client_secret_encrypted) return null
	return decryptPlatformOauthClientSecret(
		input.env,
		row.client_secret_encrypted,
		platformOauthAppContext(slug),
	)
}

async function getPlatformOauthAppRowBySlug(input: {
	db: D1Database
	slug: string
}): Promise<PlatformOauthAppRow | null> {
	const row = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns}
			FROM platform_oauth_apps
			WHERE slug = ?
			LIMIT 1`,
		)
		.bind(input.slug)
		.first<PlatformOauthAppRow>()
	return row ?? null
}

export function mapPlatformOauthAppRow(
	row: PlatformOauthAppRow,
): PlatformOauthApp {
	return {
		slug: row.slug,
		provider: row.provider,
		label: row.label,
		description: row.description ?? null,
		clientId: row.client_id,
		hasClientSecret: row.client_secret_encrypted != null,
		tokenUrl: row.token_url,
		authorizeUrl: row.authorize_url,
		deviceAuthorizationUrl: row.device_authorization_url ?? null,
		apiBaseUrl: row.api_base_url,
		flow: row.flow,
		usePkce: row.use_pkce == null ? null : row.use_pkce === 1,
		tokenExchangeStyle: row.token_exchange_style,
		scopeSeparator: row.scope_separator,
		extraAuthorizeParams: parseJsonRecord(row.extra_authorize_params_json),
		allowedScopes: parseJsonStringArray(row.allowed_scopes_json),
		defaultScopes: parseJsonStringArray(row.default_scopes_json),
		requiredHosts: parseJsonStringArray(row.required_hosts_json),
		enabled: row.enabled === 1,
		visibility: row.visibility === 'published' ? 'published' : 'draft',
		logoKey: row.logo_key ?? null,
		logoContentType: row.logo_content_type ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function normalizeScopes(scopes: Array<string>) {
	return Array.from(
		new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
	).sort((left, right) => left.localeCompare(right))
}

function parseJsonRecord(raw: string): Record<string, string> {
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
