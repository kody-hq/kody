/**
 * Labels and number copy for per-connection usage on the Connections page.
 */
import type {
	ConnectionUsageCountKey,
	ConnectionUsageEntry,
	ConnectionUsageTotals,
	ConnectionUsageWindowKey,
} from '#universal/connection-usage.ts'
import {
	connectedAgentConnectionLabel,
	type ConnectedMcpAgent,
} from '#universal/connected-mcp-agents.ts'

export const connectionUsageWindowLabels: Record<
	ConnectionUsageWindowKey,
	string
> = {
	today: 'Today',
	capWeek: 'This cap week',
	last7Days: 'Last 7 days',
}

const countNouns: Record<
	ConnectionUsageCountKey,
	{ one: string; other: string }
> = {
	executeCalls: { one: 'execute call', other: 'execute calls' },
	workerLoads: { one: 'worker load', other: 'worker loads' },
	runs: { one: 'run', other: 'runs' },
}

/** Display order for raw counts: what the user typed, then what it cost. */
export const connectionUsageCountKeys: ReadonlyArray<ConnectionUsageCountKey> =
	['executeCalls', 'workerLoads', 'runs']

export function connectionUsageCountNoun(
	key: ConnectionUsageCountKey,
	count = 2,
) {
	const noun = countNouns[key]
	return count === 1 ? noun.one : noun.other
}

export function formatConnectionUsageCount(value: number) {
	return Math.round(value).toLocaleString('en-US')
}

/** `40 execute calls`, `1 worker load`. */
export function formatConnectionUsageQuantity(
	key: ConnectionUsageCountKey,
	value: number,
) {
	const rounded = Math.round(value)
	return `${formatConnectionUsageCount(rounded)} ${connectionUsageCountNoun(key, rounded)}`
}

/**
 * Non-zero last-7-day counts other than the cap unit, for rows whose cap
 * column alone would read as zero: `14 runs`, `4,020 execute calls, 3 worker loads`.
 */
export function connectionUsageOtherCounts(
	totals: ConnectionUsageTotals,
	capCountKey: ConnectionUsageCountKey,
) {
	return connectionUsageCountKeys
		.filter((key) => key !== capCountKey && totals.last7Days[key] > 0)
		.map((key) => formatConnectionUsageQuantity(key, totals.last7Days[key]))
		.join(', ')
}

export function connectionUsageHasActivity(totals: ConnectionUsageTotals) {
	return connectionUsageCountKeys.some((key) => totals.last7Days[key] > 0)
}

export function connectionUsageKindLabel(credentialKind: string) {
	switch (credentialKind) {
		case 'mcp-oauth':
			return 'MCP agent'
		case 'cli':
			return 'Kody CLI'
		case 'api-token':
			return 'API token'
		case 'session':
			return 'Signed-in browser'
		case 'package-app':
			return 'Package app'
		default:
			return 'Connection'
	}
}

/**
 * Name for one of the viewer's own connections. MCP agents reuse the
 * connected-agents label for the same client id; an agent that has since
 * been revoked falls back to its client id label.
 */
export function connectionUsageEntryLabel(
	entry: Pick<
		ConnectionUsageEntry,
		'credentialKind' | 'credentialId' | 'label'
	>,
	agents: ReadonlyArray<Pick<ConnectedMcpAgent, 'clientId' | 'label'>>,
) {
	switch (entry.credentialKind) {
		case 'mcp-oauth': {
			const agent = agents.find(
				(candidate) => candidate.clientId === entry.credentialId,
			)
			if (agent) return agent.label
			return entry.credentialId
				? connectedAgentConnectionLabel(entry.credentialId)
				: 'MCP agent'
		}
		case 'cli':
			return 'Kody CLI (kody login)'
		case 'api-token':
			return entry.label?.trim() || 'Deleted API token'
		case 'session':
			return 'Kody website'
		case 'package-app':
			return 'Package apps'
		default:
			return entry.label?.trim() || entry.credentialKind
	}
}
