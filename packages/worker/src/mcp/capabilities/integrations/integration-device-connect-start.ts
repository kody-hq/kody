import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { startIntegrationDeviceConnect } from '#worker/integrations/device-connect.ts'
import { tokenExchangeStyleValues } from './integration-shared.ts'

const inputSchema = z.object({
	provider: z
		.string()
		.min(1)
		.describe(
			'Connection / provider name to create or reconnect via device authorization.',
		),
	platformAppSlug: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional platform (built-in) app slug. When set, endpoints and client id come from the app row.',
		),
	tokenUrl: z.string().url().optional(),
	deviceAuthorizationUrl: z.string().url().optional(),
	authorizeUrl: z.string().url().optional(),
	apiBaseUrl: z.string().url().nullable().optional(),
	clientId: z.string().min(1).optional(),
	clientSecret: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional client secret for confidential device clients. Never returned in outputs.',
		),
	scopes: z.array(z.string()).optional(),
	scopeSeparator: z.string().nullable().optional(),
	extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
	allowedHosts: z.array(z.string()).optional(),
	tokenExchangeStyle: z.enum(tokenExchangeStyleValues).optional(),
	usePkce: z.boolean().nullable().optional(),
})

const outputSchema = z.object({
	ok: z.literal(true),
	sessionId: z
		.string()
		.describe('Opaque session id for integrationDeviceConnectPoll.'),
	userCode: z.string().describe('Code the user enters at the provider.'),
	verificationUri: z.string().url(),
	verificationUriComplete: z.string().url().nullable(),
	expiresIn: z.number().int().positive(),
	interval: z.number().int().positive(),
})

export const integrationDeviceConnectStartCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationDeviceConnectStart',
		orgPermission: 'integration:write',
		description:
			'Start RFC 8628 OAuth device authorization for an integration. Returns a user_code and verification URI for the signed-in user to approve at the provider. The provider device_code and any client secret stay server-side and never appear in the output. Poll with integrationDeviceConnectPoll until approved or failed. Prefer /connect/oauth?flow=device for interactive browser flows; use this capability when an agent must drive device connect without a browser redirect.',
		keywords: [
			'integration',
			'oauth',
			'device',
			'device code',
			'rfc 8628',
			'connect',
			'authorization',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const started = await startIntegrationDeviceConnect({
				env: ctx.env,
				request,
				mcpUser: user,
				provider: args.provider,
				platformAppSlug: args.platformAppSlug,
				tokenUrl: args.tokenUrl,
				apiBaseUrl: args.apiBaseUrl ?? null,
				authorizeUrl: args.authorizeUrl,
				deviceAuthorizationUrl: args.deviceAuthorizationUrl,
				clientId: args.clientId,
				clientSecret: args.clientSecret,
				usePkce: args.usePkce ?? null,
				scopes: args.scopes ?? [],
				scopeSeparator: args.scopeSeparator ?? null,
				extraAuthorizeParams: args.extraAuthorizeParams ?? {},
				allowedHosts: args.allowedHosts ?? [],
				tokenExchangeStyle: args.tokenExchangeStyle ?? null,
			})
			if (!started.ok) {
				throw new McpCallerError(started.error)
			}
			return {
				ok: true as const,
				sessionId: started.sessionId,
				userCode: started.userCode,
				verificationUri: started.verificationUri,
				verificationUriComplete: started.verificationUriComplete,
				expiresIn: started.expiresIn,
				interval: started.interval,
			}
		},
	},
)
