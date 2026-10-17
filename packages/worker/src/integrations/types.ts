import { z } from 'zod'
import { type IntegrationAuthFailureReason } from '#universal/connection-trouble.ts'
import {
	integrationFlowValues,
	tokenExchangeStyleValues,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { type PlatformOauthApp } from './platform-apps.ts'
import { type IntegrationRefreshPolicy } from './refresh-policy.ts'
import { integrationUsageModeValues } from './usage-mode.ts'
export const oauthAppFlowSchema = z.enum(integrationFlowValues)
export const oauthTokenExchangeStyleSchema = z.enum(tokenExchangeStyleValues)

export const userOauthAppSchema = z.object({
	userId: z.string().min(1),
	slug: z.string().min(1),
	provider: z.string().min(1),
	label: z.string().min(1).nullable(),
	clientId: z.string().min(1),
	hasClientSecret: z.boolean(),
	tokenUrl: z.string().url(),
	authorizeUrl: z.string().url().nullable(),
	deviceAuthorizationUrl: z.string().url().nullable(),
	apiBaseUrl: z.string().url().nullable(),
	flow: oauthAppFlowSchema,
	usePkce: z.boolean().nullable(),
	tokenExchangeStyle: oauthTokenExchangeStyleSchema.nullable(),
	scopeSeparator: z.string().min(1).nullable(),
	extraAuthorizeParams: z.record(z.string(), z.string()),
	logoKey: z.string().min(1).nullable().optional(),
	logoContentType: z.string().min(1).nullable().optional(),
	logoSource: z.enum(['upload', 'favicon']).nullable().optional(),
	faviconSourceHost: z.string().min(1).nullable().optional(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type UserOauthApp = z.infer<typeof userOauthAppSchema>

export const userIntegrationConnectionSchema = z.object({
	/** Stable credential id, assigned by the database on insert. */
	credentialId: z.string().min(1),
	userId: z.string().min(1),
	name: z.string().min(1),
	/** User-owned OAuth app slug; null for platform-app connections. */
	appSlug: z.string().min(1).nullable(),
	/** Platform (built-in) app slug; null for user-owned app connections. */
	platformAppSlug: z.string().min(1).nullable(),
	accountLabel: z.string().min(1).nullable(),
	description: z.string(),
	scopes: z.array(z.string()),
	requiredHosts: z.array(z.string()),
	usageMode: z.enum(integrationUsageModeValues),
	allowedPackageIds: z.array(z.string()),
	connectedAt: z.string().min(1).nullable(),
	tokenRefreshedAt: z.string().min(1).nullable(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type UserIntegrationConnection = z.infer<
	typeof userIntegrationConnectionSchema
> & {
	lastAuthFailure?: IntegrationAuthFailureSnapshot | null
	refreshPolicy?: IntegrationRefreshPolicy | null
}

export type UserOauthAppWithConnectionCount = UserOauthApp & {
	connectionCount: number
}

/**
 * A connection joined to the app that owns its client credentials. The lane
 * discriminant matches which of `connection.appSlug` /
 * `connection.platformAppSlug` is set.
 */
export type JoinedIntegration =
	| {
			lane: 'user'
			app: UserOauthApp
			connection: UserIntegrationConnection
	  }
	| {
			lane: 'platform'
			app: PlatformOauthApp
			connection: UserIntegrationConnection
	  }

export type UserOauthAppRow = {
	user_id: string
	slug: string
	provider: string
	label: string | null
	client_id: string
	has_client_secret?: number | null
	token_url: string
	authorize_url: string | null
	device_authorization_url: string | null
	api_base_url: string | null
	flow: (typeof integrationFlowValues)[number]
	use_pkce: number | null
	token_exchange_style: (typeof tokenExchangeStyleValues)[number] | null
	scope_separator: string | null
	extra_authorize_params_json: string
	logo_key: string | null
	logo_content_type: string | null
	logo_source: 'upload' | 'favicon' | null
	favicon_source_host: string | null
	created_at: string
	updated_at: string
}

export type UserIntegrationRow = {
	id: string
	user_id: string
	name: string
	app_slug: string | null
	platform_app_slug: string | null
	account_label: string | null
	description: string
	scopes_json: string
	required_hosts_json: string
	access_token_encrypted?: string | null
	refresh_token_encrypted?: string | null
	usage_mode?: (typeof integrationUsageModeValues)[number]
	allowed_packages_json?: string
	connected_at: string | null
	token_refreshed_at: string | null
	auth_failed_at?: string | null
	auth_failed_reason?: string | null
	auth_failed_provider_error?: string | null
	auth_failed_provider_description?: string | null
	auth_failed_http_status?: number | null
	auth_failed_reconnectable?: number | null
	refresh_policy?: string | null
	created_at: string
	updated_at: string
}

export type IntegrationAuthFailureSnapshot = {
	occurredAt: string
	reason: IntegrationAuthFailureReason
	providerError: string | null
	providerErrorDescription: string | null
	httpStatus: number | null
	reconnectable: boolean
}
