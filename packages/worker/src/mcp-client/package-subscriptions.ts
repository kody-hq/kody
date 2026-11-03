import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { readSignupOrgSlugOrNull } from '#worker/orgs/signup-org-slug.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	loadMatchingPackageSubscriptions,
	readPreExecutionPackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import {
	mcpServerDisconnectedTopic,
	mcpServerReconnectedTopic,
	type McpServerConnectionEvent,
	type McpServerConnectionEventTopic,
} from './connection-episodes.ts'
import { listEnabledMcpServerSettingRows } from './settings-repo.ts'
import type { McpServerConnectionState } from './types.ts'

export { mcpServerDisconnectedTopic, mcpServerReconnectedTopic }

export type McpServerConnectionSubscriptionEnvelope = {
	event: McpServerConnectionEventTopic
	event_id: string
	server: {
		id: string
		name: string
		state: McpServerConnectionState
		previous_state: McpServerConnectionState | 'unknown'
		episode_id: string
	}
	observed_at: string
	account_url: string
}

export function buildMcpServerAccountUrl(input: {
	baseUrl: string
	orgSlug: string
	serverId: string
}) {
	return `${input.baseUrl}${orgSectionRestPath(
		input.orgSlug,
		'mcp-servers',
		input.serverId,
	)}`
}

function buildSubscriptionIdempotencyKey(input: {
	topic: McpServerConnectionEventTopic
	episodeId: string
	packageId: string
}) {
	return `mcp-server:${input.topic}:${input.episodeId}:${input.packageId}`
}

function buildEventPayload(input: {
	baseUrl: string
	orgSlug: string
	event: McpServerConnectionEvent
}): McpServerConnectionSubscriptionEnvelope {
	return {
		event: input.event.topic,
		event_id: input.event.eventId,
		server: {
			id: input.event.serverId,
			name: input.event.serverName,
			state: input.event.state,
			previous_state: input.event.previousState,
			episode_id: input.event.episodeId,
		},
		observed_at: input.event.observedAt,
		account_url: buildMcpServerAccountUrl({
			baseUrl: input.baseUrl,
			orgSlug: input.orgSlug,
			serverId: input.event.serverId,
		}),
	}
}

async function loadMatchingMcpServerSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: McpServerConnectionEventTopic
}) {
	try {
		return await loadMatchingPackageSubscriptions(input)
	} catch (error) {
		return { subscriptions: [], discoveryErrors: [error] }
	}
}

/**
 * Fan an MCP server connection episode out to the owning user's packages that
 * declare the topic. Best-effort: discovery and invocation infrastructure
 * failures are logged, never thrown. Sibling handler terminal failures are
 * isolated via `Promise.allSettled`. `complete` is false when discovery is
 * incomplete or a retryable invoke failed, so the hub can leave the event
 * pending.
 *
 * One emit per topic per episode. Packages decide how to notify.
 */
export async function dispatchMcpServerConnectionSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	event: McpServerConnectionEvent
	orgSlug?: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingMcpServerSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
			topic: input.event.topic,
		})
	const orgSlug = await readSignupOrgSlugOrNull(
		input.env.APP_DB,
		input.userId,
		input.orgSlug,
	)
	if (!orgSlug) {
		if (discoveryErrors.length > 0) {
			console.warn(
				'mcp.server connection package subscription discovery incomplete',
				{
					eventId: input.event.eventId,
					topic: input.event.topic,
					serverName: input.event.serverName,
					errorCount: discoveryErrors.length,
					error: discoveryErrors[0],
				},
			)
		}
		return { results: [], complete: false }
	}
	const eventPayload = buildEventPayload({
		baseUrl,
		orgSlug,
		event: input.event,
	})
	const settled = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: input.event.topic,
						params: eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							topic: input.event.topic,
							episodeId: input.event.episodeId,
							packageId: savedPackage.id,
						}),
						source: 'mcp-client',
						request: { kind: 'platform-event', sourceId: 'mcp-client' },
						waitUntil: input.waitUntil,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)
	let invokeFailed = false
	for (const result of settled) {
		if (result.status === 'rejected') {
			invokeFailed = true
			console.warn('mcp.server connection package subscription invoke failed', {
				eventId: input.event.eventId,
				topic: input.event.topic,
				serverName: input.event.serverName,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		console.warn(
			'mcp.server connection package subscription discovery incomplete',
			{
				eventId: input.event.eventId,
				topic: input.event.topic,
				serverName: input.event.serverName,
				errorCount: discoveryErrors.length,
				error: discoveryErrors[0],
			},
		)
	}
	return {
		results: settled.map((result) =>
			result.status === 'fulfilled' ? result.value : null,
		),
		complete: discoveryErrors.length === 0 && !invokeFailed,
	}
}

export async function emitMcpServerConnectionEventsIfNeeded(input: {
	env: Env
	userId: string
	events: Array<McpServerConnectionEvent>
	orgSlug?: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<boolean> {
	if (input.events.length === 0) return true
	let enabledIds: Set<string>
	try {
		const rows = await listEnabledMcpServerSettingRows({
			db: input.env.APP_DB,
			userId: input.userId,
		})
		enabledIds = new Set(rows.map((row) => row.id))
	} catch (error) {
		console.warn('mcp.server connection event enabled-server lookup failed', {
			error,
		})
		return false
	}
	const pending = input.events
		.filter((event) => enabledIds.has(event.serverId))
		.map((event) =>
			dispatchMcpServerConnectionSubscriptionEvents({
				env: input.env,
				userId: input.userId,
				event,
				orgSlug: input.orgSlug,
				waitUntil: input.waitUntil,
			}),
		)
	if (pending.length === 0) return true
	const outcomes = await Promise.all(pending)
	return outcomes.every((outcome) => outcome.complete)
}
