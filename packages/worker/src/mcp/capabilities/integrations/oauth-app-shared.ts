import { z } from 'zod'
import { buildUserOauthAppLogoPaths } from '#worker/integrations/user-oauth-app-logo.ts'
import {
	type UserOauthApp,
	type UserOauthAppWithConnectionCount,
} from '#worker/integrations/types.ts'
import {
	integrationFlowValues,
	tokenExchangeStyleValues,
} from './integration-shared.ts'

/**
 * Public OAuth-app projection for MCP capabilities.
 * Never includes client secret or token values.
 */
export const oauthAppConnectionRefSchema = z.object({
	name: z.string().min(1),
	accountLabel: z.string().nullable(),
})

export const oauthAppPublicSchema = z.object({
	slug: z.string().min(1),
	provider: z.string().min(1),
	label: z.string().nullable(),
	clientId: z.string().min(1),
	hasClientSecret: z.boolean(),
	tokenUrl: z.string().url(),
	authorizeUrl: z.string().url().nullable(),
	deviceAuthorizationUrl: z.string().url().nullable(),
	apiBaseUrl: z.string().url().nullable(),
	flow: z.enum(integrationFlowValues),
	usePkce: z.boolean().nullable(),
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).nullable(),
	scopeSeparator: z.string().nullable(),
	extraAuthorizeParams: z.record(z.string(), z.string()),
	connectionCount: z.number().int().nonnegative(),
	connections: z.array(oauthAppConnectionRefSchema),
	logoPath: z.string().nullable().optional(),
	autoLogoPath: z.string().nullable().optional(),
	logoSource: z.enum(['upload', 'favicon']).nullable().optional(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type OauthAppPublic = z.infer<typeof oauthAppPublicSchema>

export function toOauthAppPublic(
	app: UserOauthApp | UserOauthAppWithConnectionCount,
	connections: Array<{ name: string; accountLabel: string | null }>,
): OauthAppPublic {
	const connectionCount =
		'connectionCount' in app ? app.connectionCount : connections.length
	const logoPaths = buildUserOauthAppLogoPaths(app)
	return {
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
		connectionCount,
		connections,
		logoPath: logoPaths.logoPath,
		autoLogoPath: logoPaths.autoLogoPath,
		logoSource: app.logoSource,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}
