/**
 * Usage-state lifecycle campaign. One campaign state per user. Branch on
 * activation stamps and live reads, not a fixed week-1/3 calendar drip.
 * Kit stays exist-only tags; these mails use the standard transactional
 * template from kody@kody.codes.
 */

import {
	usageCampaignState,
	usageCampaignTags,
	type UsageCampaignState,
} from './usage-campaign-state.ts'
import { describeSecondAgentStandardGift } from '#universal/second-agent-standard-gift.ts'

export const usageCampaignStates = Object.freeze(
	usageCampaignState.states.map((phase) => usageCampaignTags[phase]),
)

export type { UsageCampaignState } from './usage-campaign-state.ts'

export const usageCampaignMailTemplates = [
	'verified_no_mcp',
	'connected_no_package',
	'packaged_single_client',
	'cooling',
	'advocate_referral_testimonial',
] as const

export type UsageCampaignMailTemplate =
	(typeof usageCampaignMailTemplates)[number]

export const usageCampaignOrigins = ['seed', 'event'] as const

export type UsageCampaignOrigin = (typeof usageCampaignOrigins)[number]

export const usageCampaignSendCaps = {
	VerifiedNoMcp: 2,
	ConnectedNoPackage: 2,
	PackagedSingleClient: 2,
	Activated: 0,
	Cooling: 1,
	LimitAware: 0,
	Paid: 0,
} as const satisfies Record<UsageCampaignState, number>

export const usageCampaignTemplateByState = {
	VerifiedNoMcp: 'verified_no_mcp',
	ConnectedNoPackage: 'connected_no_package',
	PackagedSingleClient: 'packaged_single_client',
	Cooling: 'cooling',
	Activated: null,
	LimitAware: null,
	Paid: null,
} as const satisfies Record<
	UsageCampaignState,
	UsageCampaignMailTemplate | null
>

/** Minimum time in the same mail-eligible state before send 2 (and later). */
export const usageCampaignSendIntervalMs = 5 * 24 * 60 * 60 * 1000

/**
 * After a transition into a mail-eligible state, wait before the first
 * campaign send so someone mid-onboarding is not mailed the same hour.
 * Verify-time VerifiedNoMcp send 1 bypasses this.
 */
export const usageCampaignFirstSendDwellMs = 24 * 60 * 60 * 1000

/** Latest known activity older than this, with no enabled job. */
export const usageCampaignCoolingStaleMs = 21 * 24 * 60 * 60 * 1000

/**
 * Activated or Paid (or first-activated + later Paid) tenure before the
 * one-shot advocate / referral mail. Not a drip; send_index 1 forever.
 */
export const usageCampaignAdvocateMinTenureMs = 7 * 24 * 60 * 60 * 1000

export const usageCampaignAdvocateSendIndex = 1

export function isAdvocateCampaignTemplate(
	template: UsageCampaignMailTemplate | null,
) {
	return template === 'advocate_referral_testimonial'
}

/** last_active_at window used with execute depth for "strong recent use". */
export const usageCampaignStrongUseActiveMs = 7 * 24 * 60 * 60 * 1000

export const usageCampaignStrongUseMinExecuteEvents = 3

export const usageCampaignSweepLimit = 80
export const usageCampaignSweepConcurrency = 4

/** Same 80% crossing the entitlement-warning lane uses for LimitAware. */
export const usageCampaignLimitAwareThreshold = 0.8

export function isUsageCampaignState(
	value: string,
): value is UsageCampaignState {
	return (usageCampaignStates as ReadonlyArray<string>).includes(value)
}

export function isUsageCampaignMailTemplate(
	value: string,
): value is UsageCampaignMailTemplate {
	return (usageCampaignMailTemplates as ReadonlyArray<string>).includes(value)
}

export function isUsageCampaignOrigin(
	value: string,
): value is UsageCampaignOrigin {
	return (usageCampaignOrigins as ReadonlyArray<string>).includes(value)
}

export function campaignClientLabel(mcpClientName: string | null | undefined) {
	const trimmed = mcpClientName?.trim() ?? ''
	if (trimmed === '') return 'your agent'
	return trimmed.length > 40 ? `${trimmed.slice(0, 37)}…` : trimmed
}

/**
 * PackagedSingleClient advertises the 14-day Standard gift only while the
 * user has not yet received it. Connecting a second unique inbound client
 * is what records the gift.
 */
export function isPackagedSingleClientTrialCtaLive(input: {
	grantedAt?: string | null
	expiresAt?: string | null
	now?: Date
}) {
	return describeSecondAgentStandardGift(input).status === 'none'
}
