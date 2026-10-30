import {
	type McpServer,
	type ServerCapabilities,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { resolveCallerFeatureFlagEvaluations } from '#mcp/capabilities/access-control.ts'
import { recordMcpEventsClientsFlagExposure } from '#worker/feature-flags/mcp-events-clients-exposure.ts'
import {
	mcpEventsListMethod,
	mcpEventsSubscribeMethod,
	mcpEventsUnsubscribeMethod,
} from './constants.ts'
import { listMcpEventSources, mcpEventInputSchema } from './list-events.ts'
import {
	mcpEventsSubscribeParamsSchema,
	mcpEventsSubscribeResultSchema,
	subscribeMcpEvent,
	type McpEventsPrincipal,
} from './subscribe.ts'
import {
	mcpEventsUnsubscribeParamsSchema,
	mcpEventsUnsubscribeResultSchema,
	unsubscribeMcpEvent,
} from './unsubscribe.ts'

const mcpEventsListParamsSchema = z
	.looseObject({ cursor: z.string().nullable().optional() })
	.optional()

const mcpEventsListResultSchema = z.object({
	events: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			delivery: z.array(z.literal('webhook')),
			inputSchema: z.record(z.string(), z.unknown()),
			payloadSchema: z.record(z.string(), z.unknown()),
		}),
	),
})

/**
 * Progressive enhancement on the stateless lane, following the OpenAI MCP
 * Events profile: the server advertises `events` and clients declare
 * nothing. Kody advertises `events` and serves
 * `events/list|subscribe|unsubscribe` only when the caller is an OAuth
 * principal and the `mcp-events-extension` flag is on for the user.
 * Otherwise nothing is registered and the methods answer MethodNotFound.
 * See ADR 0087.
 *
 * SDK workaround: `ServerCapabilitiesSchema` has no `events` key, so the
 * typed capability object cannot name it; the SDK spreads capabilities into
 * the `server/discover` result at runtime, so the cast is load-bearing only
 * for types. Custom methods use the 3-arg `setRequestHandler` form.
 */
export async function registerMcpEvents(input: {
	server: McpServer
	env: Env
	callerContext: McpCallerContext
	oauthClientId: string | null
}): Promise<boolean> {
	if (!input.callerContext.user?.userId || !input.oauthClientId) return false
	// Dedicated exposure site: do not use resolveCallerFeatureFlags (evaluation
	// chokepoint) so execute and other non-events clients stay out of cohorts.
	// Clients no longer declare events support, so the exposure is written
	// when the client calls an `events/*` method, not on every request.
	const evaluations = await resolveCallerFeatureFlagEvaluations(
		input.env,
		input.callerContext,
	)
	const evaluation = evaluations?.[mcpEventsExtensionFlagKey]
	if (!evaluation?.enabled) return false
	const stableUserId = input.callerContext.user.userId
	let exposure: Promise<void> | null = null
	const recordExposure = async () => {
		exposure ??= recordMcpEventsClientsFlagExposure({
			env: input.env,
			stableUserId,
			evaluation,
		})
		await exposure
	}

	const principal: McpEventsPrincipal = {
		env: input.env,
		callerContext: input.callerContext,
		oauthClientId: input.oauthClientId,
	}
	const eventsCapability: Record<string, unknown> = { events: {} }
	input.server.server.registerCapabilities(
		eventsCapability as ServerCapabilities,
	)
	input.server.server.setRequestHandler(
		mcpEventsListMethod,
		{ params: mcpEventsListParamsSchema, result: mcpEventsListResultSchema },
		async () => {
			await recordExposure()
			const sources = await listMcpEventSources({
				env: input.env,
				callerContext: input.callerContext,
			})
			return {
				events: [...sources.values()].map(({ definition }) => ({
					...definition,
					inputSchema: { ...mcpEventInputSchema },
				})),
			}
		},
	)
	input.server.server.setRequestHandler(
		mcpEventsSubscribeMethod,
		{
			params: mcpEventsSubscribeParamsSchema,
			result: mcpEventsSubscribeResultSchema,
		},
		async (params) => {
			await recordExposure()
			return await subscribeMcpEvent(principal, params)
		},
	)
	input.server.server.setRequestHandler(
		mcpEventsUnsubscribeMethod,
		{
			params: mcpEventsUnsubscribeParamsSchema,
			result: mcpEventsUnsubscribeResultSchema,
		},
		async (params) => {
			await recordExposure()
			return await unsubscribeMcpEvent(principal, params)
		},
	)
	return true
}
