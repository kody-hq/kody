/**
 * MCP Events client-support readout for the `mcp-events-extension` flag.
 *
 * The flag's exposure cohort only counts callers of `events/*` methods, so
 * hosts that never implement events (they ignore `capabilities.events`)
 * never enter it, and the cohort reads near zero. This readout reads the
 * `kody_mcp_protocol_events` Analytics Engine dataset over the current UTC
 * month to date and splits every MCP user (blob6) by what their client did:
 *
 * - `doesNotAdvertise`: never declared events support (blob9) and never
 *   called an `events/*` method.
 * - `advertisesNotSubscribed`: declared events support or called an
 *   `events/*` method (the OpenAI profile declares nothing and goes straight
 *   to `events/list`), but never called `events/subscribe`.
 * - `subscribed`: called `events/subscribe`.
 *
 * A user counts once in the totals by their furthest step across clients;
 * `clients` repeats the split per client name. Counts only.
 */

import { queryAnalyticsEngineSql } from '#worker/usage/aggregate-rollups.ts'
import type {
	McpEventsClientSupportCounts,
	McpEventsClientSupportReadout,
} from '#universal/feature-flags/types.ts'

export type McpEventsClientSupportReadoutEnv = {
	MCP_PROTOCOL_EVENTS?: AnalyticsEngineDataset
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

export type McpEventsClientSupportRow = {
	user_id: string
	client_name: string
	declared_requests: number | string
	events_requests: number | string
	subscribe_requests: number | string
}

type Step = 'doesNotAdvertise' | 'advertisesNotSubscribed' | 'subscribed'

const stepRank: Record<Step, number> = {
	doesNotAdvertise: 0,
	advertisesNotSubscribed: 1,
	subscribed: 2,
}

function resolveMcpProtocolEventsDataset(env: { SENTRY_ENVIRONMENT?: string }) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_mcp_protocol_events_preview'
		: 'kody_mcp_protocol_events'
}

function emptyCounts(): McpEventsClientSupportCounts {
	return {
		users: 0,
		doesNotAdvertise: 0,
		advertisesNotSubscribed: 0,
		subscribed: 0,
	}
}

function rowStep(row: McpEventsClientSupportRow): Step {
	if (Number(row.subscribe_requests) > 0) return 'subscribed'
	if (Number(row.declared_requests) > 0 || Number(row.events_requests) > 0) {
		return 'advertisesNotSubscribed'
	}
	return 'doesNotAdvertise'
}

export function buildMcpEventsClientSupportReadout(input: {
	rows: Array<McpEventsClientSupportRow>
	windowStart: string
	windowEnd: string
}): McpEventsClientSupportReadout {
	const userSteps = new Map<string, Step>()
	const clients = new Map<string, McpEventsClientSupportCounts>()
	for (const row of input.rows) {
		if (!row.user_id) continue
		const step = rowStep(row)
		const previous = userSteps.get(row.user_id)
		if (!previous || stepRank[step] > stepRank[previous]) {
			userSteps.set(row.user_id, step)
		}
		const clientName = row.client_name || '(unknown)'
		const client = clients.get(clientName) ?? emptyCounts()
		client.users += 1
		client[step] += 1
		clients.set(clientName, client)
	}
	const totals = emptyCounts()
	for (const step of userSteps.values()) {
		totals.users += 1
		totals[step] += 1
	}
	return {
		status: 'ok',
		windowStart: input.windowStart,
		windowEnd: input.windowEnd,
		...totals,
		clients: [...clients.entries()]
			.map(([clientName, counts]) => ({ clientName, ...counts }))
			.sort(
				(left, right) =>
					right.users - left.users ||
					left.clientName.localeCompare(right.clientName),
			),
	}
}

export async function loadMcpEventsClientSupportReadout(
	env: McpEventsClientSupportReadoutEnv,
	now: Date = new Date(),
): Promise<McpEventsClientSupportReadout> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (
		!env.MCP_PROTOCOL_EVENTS ||
		env.WRANGLER_IS_LOCAL_DEV === 'true' ||
		!accountId ||
		!apiToken
	) {
		return {
			status: 'unavailable',
			reason:
				'MCP protocol events are only recorded in Analytics Engine; the MCP_PROTOCOL_EVENTS binding or Analytics Engine SQL credentials are not available here.',
		}
	}
	const monthStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
	)
	const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000)
	const toDateTime = (date: Date) =>
		date.toISOString().slice(0, 'YYYY-MM-DDTHH:MM:SS'.length).replace('T', ' ')
	const query = `
SELECT
	blob6 AS user_id,
	blob4 AS client_name,
	sum(if(blob9 = 'declared', _sample_interval, 0)) AS declared_requests,
	sum(if(blob2 LIKE 'events/%', _sample_interval, 0)) AS events_requests,
	sum(if(blob2 = 'events/subscribe', _sample_interval, 0)) AS subscribe_requests
FROM ${resolveMcpProtocolEventsDataset(env)}
WHERE timestamp >= toDateTime('${toDateTime(monthStart)}')
	AND timestamp < toDateTime('${toDateTime(nextDay)}')
	AND blob6 != ''
GROUP BY blob6, blob4
FORMAT JSON
`.trim()
	try {
		const rows = await queryAnalyticsEngineSql<McpEventsClientSupportRow>({
			accountId,
			apiToken,
			baseUrl:
				env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com',
			query,
		})
		return buildMcpEventsClientSupportReadout({
			rows,
			windowStart: monthStart.toISOString(),
			windowEnd: now.toISOString(),
		})
	} catch (error) {
		console.warn('mcp-events-client-support-readout-failed', error)
		const detail = error instanceof Error ? error.message : String(error)
		return {
			status: 'unavailable',
			reason: `MCP Events client-support query failed: ${detail.slice(0, 600)}`,
		}
	}
}
