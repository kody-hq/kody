import { z } from 'zod'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import {
	platformOauthAppVisibilityValues,
	type PlatformOauthApp,
} from '#worker/integrations/platform-apps.ts'
import {
	integrationFlowValues,
	tokenExchangeStyleValues,
} from './integration-shared.ts'

/**
 * Public platform-app projection for MCP capabilities and loaders. Never
 * includes the client secret in any form — not even a secret name, because
 * the shared credential has no user-facing reference by design. `clientId`
 * is a non-secret OAuth identifier.
 */
export const platformOauthAppPublicSchema = z.object({
	slug: z.string().min(1),
	provider: z.string().min(1),
	label: z.string().nullable(),
	/** Operator-authored note (limitations, scope caveats) shown pre-connect. */
	description: z.string().nullable(),
	clientId: z.string().min(1),
	tokenUrl: z.string().url(),
	/** Empty string allowed for device-only apps (no authorization_code URL). */
	authorizeUrl: z.union([z.string().url(), z.literal('')]),
	deviceAuthorizationUrl: z.string().url().nullable(),
	apiBaseUrl: z.string().url().nullable(),
	flow: z.enum(integrationFlowValues),
	usePkce: z.boolean().nullable(),
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).nullable(),
	scopeSeparator: z.string().nullable(),
	extraAuthorizeParams: z.record(z.string(), z.string()),
	allowedScopes: z.array(z.string()),
	defaultScopes: z.array(z.string()),
	requiredHosts: z.array(z.string()),
	enabled: z.boolean(),
	visibility: z.enum(platformOauthAppVisibilityValues),
	/** Relative serving path of the operator-uploaded logo, or null. */
	logoPath: z.string().nullable(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export type PlatformOauthAppPublic = z.infer<
	typeof platformOauthAppPublicSchema
>

export function toPlatformOauthAppPublic(
	app: PlatformOauthApp,
): PlatformOauthAppPublic {
	return {
		slug: app.slug,
		provider: app.provider,
		label: app.label,
		description: app.description,
		clientId: app.clientId,
		tokenUrl: app.tokenUrl,
		authorizeUrl: app.authorizeUrl,
		deviceAuthorizationUrl: app.deviceAuthorizationUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		tokenExchangeStyle: app.tokenExchangeStyle,
		scopeSeparator: app.scopeSeparator,
		extraAuthorizeParams: app.extraAuthorizeParams,
		allowedScopes: app.allowedScopes,
		defaultScopes: app.defaultScopes,
		requiredHosts: app.requiredHosts,
		enabled: app.enabled,
		visibility: app.visibility,
		logoPath: buildPlatformOauthAppLogoPath(app),
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}
