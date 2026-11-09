/**
 * Shared types for the kody status worker: probe outcomes, per-component
 * state, and the snapshot shape the public page renders.
 */

import type { ExecuteHealthSnapshot } from './execute-health.ts'
import type { IncidentRetrospective } from './retrospective.ts'
import type { ProviderIncident } from './provider-incidents.ts'

export type { ExecuteHealthSnapshot, ProviderIncident }

export const statusComponents = [
	{ id: 'app', name: 'App & API' },
	{ id: 'mcp', name: 'MCP endpoint' },
	{ id: 'package_apps', name: 'Package runtime' },
	{ id: 'jobs', name: 'Jobs' },
	{ id: 'app_db', name: 'Primary database' },
	// AUDIT_DB is fail-open operator evidence on /health/components only;
	// it is not a public status card.
	{ id: 'kv', name: 'Key-value storage' },
	{ id: 'assets', name: 'Asset storage' },
] as const

export type StatusComponentId = (typeof statusComponents)[number]['id']

export const statusComponentIds = statusComponents.map(
	(component) => component.id,
)

export function isStatusComponentId(value: string): value is StatusComponentId {
	return (statusComponentIds as ReadonlyArray<string>).includes(value)
}

export function statusComponentName(id: StatusComponentId): string {
	const component = statusComponents.find((entry) => entry.id === id)
	return component?.name ?? id
}

export type ProbeOutcome = {
	component: StatusComponentId
	ok: boolean
	latencyMs: number | null
	detail: string | null
}

export type ComponentStatus = 'operational' | 'down' | 'unknown'

export type IncidentView = {
	id: number
	component: StatusComponentId
	componentName: string
	startedAt: string
	resolvedAt: string | null
	detail: string | null
	/** Operator writeup. Null when probes opened/resolved the incident only. */
	retrospective: IncidentRetrospective | null
}

export type ComponentDayStat = {
	day: string
	total: number
	failed: number
	/** Minutes an opened incident overlapped this UTC day. Isolated probe
	 * failures below the consecutive-failure threshold stay 0. */
	incidentMinutes: number
}

export type ComponentSnapshot = {
	id: StatusComponentId
	name: string
	status: ComponentStatus
	latencyMs: number | null
	uptimePct: number | null
	days: Array<ComponentDayStat>
}

export type StatusSnapshot = {
	generatedAt: string
	overallStatus: ComponentStatus
	components: Array<ComponentSnapshot>
	openIncidents: Array<IncidentView>
	recentIncidents: Array<IncidentView>
	/**
	 * Cloudflare Statuspage incidents that affect products kody runs on.
	 * Null when the feed is unavailable or the cache is too stale — the page
	 * omits the provider section in that case (fail-soft).
	 */
	providerIncidents: Array<ProviderIncident> | null
	/** Latest `commitSha` reported by production `GET /health` (main worker). */
	productionCommit: string | null
	/** Latest `commitSha` from `GET /__runtime/health` on the package origin. */
	runtimeCommit: string | null
	/** Latest `commit` from jobs-worker `GET /health`. */
	jobsCommit: string | null
	/**
	 * Traffic-backed MCP execute evidence. Missing or stale telemetry is
	 * unknown, not an outage, and does not change overallStatus.
	 */
	executeHealth: ExecuteHealthSnapshot
}
