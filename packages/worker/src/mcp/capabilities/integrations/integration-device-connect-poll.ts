import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { pollIntegrationDeviceConnect } from '#worker/integrations/device-connect.ts'

const inputSchema = z.object({
	sessionId: z
		.string()
		.min(1)
		.describe(
			'Opaque session id returned by integrationDeviceConnectStart. Never a provider device_code.',
		),
})

const outputSchema = z.discriminatedUnion('status', [
	z.object({
		ok: z.literal(true),
		status: z.literal('authorization_pending'),
		interval: z.number().int().positive(),
		expiresIn: z.number().int().nonnegative(),
	}),
	z.object({
		ok: z.literal(true),
		status: z.literal('slow_down'),
		interval: z.number().int().positive(),
		expiresIn: z.number().int().nonnegative(),
	}),
	z.object({
		ok: z.literal(true),
		status: z.literal('approved'),
		integrationName: z.string(),
		refreshTokenSaved: z.boolean(),
	}),
	z.object({
		ok: z.literal(false),
		status: z.enum([
			'access_denied',
			'expired_token',
			'invalid_session',
			'rate_limited',
			'provider_error',
			'persist_failed',
		]),
		error: z.string(),
	}),
])

export const integrationDeviceConnectPollCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationDeviceConnectPoll',
		orgPermission: 'integration:write',
		description:
			'Poll an in-flight RFC 8628 device authorization started with integrationDeviceConnectStart. Returns authorization_pending or slow_down until the user approves, then approved with the integration name (credentials are persisted server-side; token values never appear). access_denied and expired_token are terminal failures. Respect the returned interval before polling again.',
		keywords: [
			'integration',
			'oauth',
			'device',
			'poll',
			'rfc 8628',
			'authorization pending',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const polled = await pollIntegrationDeviceConnect({
				env: ctx.env,
				request,
				mcpUser: user,
				sessionId: args.sessionId,
			})
			if (!polled.ok) {
				return {
					ok: false as const,
					status: polled.status,
					error: polled.error,
				}
			}
			if (polled.status !== 'approved') {
				return {
					ok: true as const,
					status: polled.status,
					interval: polled.interval,
					expiresIn: polled.expiresIn,
				}
			}
			return {
				ok: true as const,
				status: 'approved' as const,
				integrationName: polled.integrationName,
				refreshTokenSaved: polled.refreshTokenSaved,
			}
		},
	},
)
