import { z } from 'zod'
import { requireMcpEventsUserId, type McpEventsPrincipal } from './subscribe.ts'
import {
	buildMcpEventSubscriptionId,
	deleteMcpEventSubscription,
} from './subscriptions-repo.ts'

export const mcpEventsUnsubscribeParamsSchema = z.looseObject({
	name: z.string().min(1),
	arguments: z.record(z.string(), z.unknown()).optional(),
	delivery: z.looseObject({
		mode: z.string().optional(),
		url: z.string().min(1),
	}),
})

export const mcpEventsUnsubscribeResultSchema = z.object({})

export type McpEventsUnsubscribeParams = z.infer<
	typeof mcpEventsUnsubscribeParamsSchema
>

/**
 * Resolve by the same key as subscribe (principal, url, name, arguments) and
 * delete. Idempotent: an unknown key (or an unparseable URL, which can never
 * have been subscribed) still returns `{}`.
 */
export async function unsubscribeMcpEvent(
	principal: McpEventsPrincipal,
	params: McpEventsUnsubscribeParams,
): Promise<Record<string, never>> {
	const userId = requireMcpEventsUserId(principal)
	let callbackUrl: string
	try {
		callbackUrl = new URL(params.delivery.url).href
	} catch {
		return {}
	}
	const id = await buildMcpEventSubscriptionId({
		userId,
		oauthClientId: principal.oauthClientId,
		eventName: params.name,
		arguments: params.arguments ?? {},
		callbackUrl,
	})
	await deleteMcpEventSubscription({ db: principal.env.APP_DB, userId, id })
	return {}
}
