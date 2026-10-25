import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	computeOverageIncludePercent,
	resolvePastIncludeStopLimits,
} from '#universal/compute-overage.ts'
import { labelInboundMcpClient } from '#universal/connected-mcp-agents.ts'
import { mcpClientById } from '#universal/onboarding-mcp-clients.ts'
import { type UserEntitlement } from '#universal/plans.ts'
import { preferLocalExecuteNudgeWarning } from '#universal/prefer-local-cli-execute.ts'
import { userEntitlementApproachingThreshold } from '#worker/entitlements/user-entitlement-warning-emails.ts'

/** Fresh unique execute workers today (UTC) before the prefer-local nudge. */
export const preferLocalExecuteFreshCodeThreshold = 10

/** Cap tracked conversations in MCP agent DO state (FIFO eviction). */
export const maxPreferLocalExecuteNudgeConversations = 50

export type PreferLocalExecuteNudgeState = {
	conversationIds: Array<string>
}

/**
 * True when the OAuth client is a known web-only / non-coding host that cannot
 * run shell commands. Unknown clients still see the nudge (an allowlist goes
 * stale; skip only known web-only kinds).
 */
export function isKnownWebOnlyMcpClient(
	oauthClientId: string | null | undefined,
): boolean {
	const clientId = oauthClientId?.trim()
	if (!clientId) return false
	const labeled = labelInboundMcpClient({ clientId })
	if (!labeled.kind) return false
	return mcpClientById(labeled.kind).isNonCodingAgent
}

export function formatPreferLocalExecuteNudge(): string {
	return preferLocalExecuteNudgeWarning
}

/**
 * Whether this fresh-worker claim should tip the prefer-local nudge.
 * Call only when the claim minted a new worker (`usage.created`).
 */
export function shouldTipPreferLocalExecuteNudge(input: {
	dailyFreshWorkers: number
	monthlyUniqueWorkerDays: number | null
	monthlyInclude: number | null
}): boolean {
	if (input.dailyFreshWorkers >= preferLocalExecuteFreshCodeThreshold) {
		return true
	}
	if (input.monthlyUniqueWorkerDays === null || input.monthlyInclude === null) {
		return false
	}
	const percent = computeOverageIncludePercent(
		input.monthlyUniqueWorkerDays,
		input.monthlyInclude,
	)
	return percent !== null && percent >= userEntitlementApproachingThreshold
}

export function monthlyIncludeForPreferLocalNudge(
	entitlement: Pick<
		UserEntitlement,
		'plan' | 'ladder' | 'creditWallet' | 'limitOverrides'
	>,
	now: Date,
): number {
	return resolvePastIncludeStopLimits({
		...entitlement,
		now,
	}).unique_worker_days
}

/**
 * Once-per-conversation prefer-local tip. Pure state update for DO / tests.
 */
export function applyPreferLocalExecuteNudge(input: {
	state: PreferLocalExecuteNudgeState | null | undefined
	conversationId: string
	shouldTip: boolean
}): {
	state: PreferLocalExecuteNudgeState
	nudges: Array<string>
} {
	const conversationId = input.conversationId.trim()
	const next = normalizePreferLocalExecuteNudgeState(input.state)
	if (!conversationId || !input.shouldTip) {
		return { state: next, nudges: [] }
	}
	if (next.conversationIds.includes(conversationId)) {
		return { state: next, nudges: [] }
	}
	next.conversationIds = [...next.conversationIds, conversationId].slice(
		-maxPreferLocalExecuteNudgeConversations,
	)
	return {
		state: next,
		nudges: [formatPreferLocalExecuteNudge()],
	}
}

export function normalizePreferLocalExecuteNudgeState(
	state: PreferLocalExecuteNudgeState | null | undefined,
): PreferLocalExecuteNudgeState {
	const conversationIds = Array.isArray(state?.conversationIds)
		? state.conversationIds.filter(
				(value): value is string =>
					typeof value === 'string' && value.trim() !== '',
			)
		: []
	return { conversationIds: [...conversationIds] }
}

/**
 * Daily unique-worker count from a hosted execute claim. Claims always carry
 * `created` at runtime; the response usage type omits it, so accept either.
 */
export function dailyFreshWorkersFromClaim(
	usage: { created?: boolean; used: number } | null | undefined,
): number | null {
	if (!usage || usage.created !== true) return null
	return usage.used
}

export function preferLocalNudgeMonthKey(now: Date): string {
	return utcMonthKey(now)
}
