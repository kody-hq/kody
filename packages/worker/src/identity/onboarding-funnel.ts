/**
 * Best-effort onboarding funnel points. Same contract as MCP search
 * telemetry: synchronous, nonthrowing, and a no-op without the binding.
 *
 * Production dataset `kody_onboarding_funnel_events` (preview:
 * `kody_onboarding_funnel_events_preview`). Binding
 * `ONBOARDING_FUNNEL_EVENTS` on origin (signup, verify, OAuth, checkout,
 * Waiting), platform (MCP search), and runtime (execute stamps).
 *
 * ```sql
 * SELECT blob1 AS stage, count(DISTINCT index1) AS users
 * FROM kody_onboarding_funnel_events
 * WHERE timestamp > NOW() - INTERVAL '7' DAY
 * GROUP BY stage
 * ```
 *
 * Layout:
 * - index1: stable user id (sampling key; never an email)
 * - blob1: stage
 * - blob2: family, sanitized card id, or plan
 * - blob3: mcp_connect_failed error class, otherwise empty
 * - blob4: sanitized OAuth client id, otherwise empty
 * - double1: 1
 */

import { labelInboundMcpClient } from '#universal/connected-mcp-agents.ts'
import {
	onboardingFunnelStages,
	type OnboardingFunnelStage,
} from '#universal/onboarding-funnel-point.ts'
import type {
	AdminInsightsOnboardingFunnel,
	AdminInsightsOnboardingFunnelWindow,
} from '#universal/loader-data.ts'
import {
	recordOnboardingFunnelEvent,
	type OnboardingFunnelEnv,
} from './onboarding-funnel-event.ts'

export {
	recordCheckoutFunnelEvent,
	recordOnboardingFunnelEvent,
	type OnboardingFunnelEnv,
} from './onboarding-funnel-event.ts'

const stageSet = new Set<string>(onboardingFunnelStages)

export function resolveOnboardingFunnelDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_onboarding_funnel_events_preview'
		: 'kody_onboarding_funnel_events'
}

export function mcpConnectFamily(input: {
	clientId?: string | null
	clientName?: string | null
}) {
	const clientId = input.clientId?.trim() ?? ''
	if (!clientId && !input.clientName?.trim()) return 'other'
	const labeled = labelInboundMcpClient({
		clientId: clientId || 'unknown',
		clientName: input.clientName,
	})
	return labeled.kind ?? 'other'
}

export function recordMcpConnectFunnelEvent(
	env: OnboardingFunnelEnv,
	input: {
		stage:
			| 'mcp_connect_started'
			| 'mcp_connect_succeeded'
			| 'mcp_connect_failed'
		userId: string | null | undefined
		clientId?: string | null
		clientName?: string | null
		errorClass?: string | null
	},
): void {
	const userId = input.userId?.trim() ?? ''
	if (!userId) return
	recordOnboardingFunnelEvent(env, {
		stage: input.stage,
		userId,
		dimension: mcpConnectFamily({
			clientId: input.clientId,
			clientName: input.clientName,
		}),
		errorClass: input.errorClass ?? undefined,
		clientId: input.clientId ?? undefined,
	})
}

export function emptyOnboardingFunnelWindow(
	days: 7 | 28,
): AdminInsightsOnboardingFunnelWindow {
	return {
		days,
		steps: onboardingFunnelStages.map((stage) => ({ stage, users: 0 })),
	}
}

export function emptyOnboardingFunnel(input?: {
	available?: boolean
}): AdminInsightsOnboardingFunnel {
	return {
		available: input?.available ?? false,
		windows: {
			days7: emptyOnboardingFunnelWindow(7),
			days28: emptyOnboardingFunnelWindow(28),
		},
	}
}

type FunnelCountRow = {
	stage?: string
	users?: number | string
}

export function onboardingFunnelCountQuery(input: {
	dataset: string
	days: 7 | 28
}) {
	const stages = onboardingFunnelStages.map((stage) => `'${stage}'`).join(', ')
	return `
SELECT
	blob1 AS stage,
	count(DISTINCT index1) AS users
FROM ${input.dataset}
WHERE timestamp > NOW() - INTERVAL '${input.days}' DAY
	AND blob1 IN (${stages})
GROUP BY stage
FORMAT JSON
`.trim()
}

export function foldOnboardingFunnelRows(
	days: 7 | 28,
	rows: ReadonlyArray<FunnelCountRow>,
): AdminInsightsOnboardingFunnelWindow {
	const counts = new Map<OnboardingFunnelStage, number>()
	for (const row of rows) {
		if (!row.stage || !stageSet.has(row.stage)) continue
		const users = Number(row.users)
		if (!Number.isFinite(users) || users < 0) continue
		counts.set(row.stage as OnboardingFunnelStage, users)
	}
	return {
		days,
		steps: onboardingFunnelStages.map((stage) => ({
			stage,
			users: counts.get(stage) ?? 0,
		})),
	}
}
