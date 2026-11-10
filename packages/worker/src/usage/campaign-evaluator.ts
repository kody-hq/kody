import {
	usageCampaignState,
	usageCampaignPhases,
} from './usage-campaign-state.ts'
import {
	isAdvocateCampaignTemplate,
	usageCampaignAdvocateMinTenureMs,
	usageCampaignAdvocateSendIndex,
	usageCampaignCoolingStaleMs,
	usageCampaignFirstSendDwellMs,
	usageCampaignSendCaps,
	usageCampaignSendIntervalMs,
	usageCampaignTemplateByState,
	type UsageCampaignMailTemplate,
	type UsageCampaignOrigin,
	type UsageCampaignState,
} from './campaign-states.ts'

export type UsageCampaignSnapshot = {
	emailVerifiedAt: string | null
	firstMcpConnectedAt: string | null
	firstSavedPackageAt: string | null
	lastActiveAt: string | null
	distinctInboundClientCount: number
	/** True when grant listing failed. Do not treat count as 0. */
	inboundListingFailed?: boolean
	hasEnabledScheduledJob: boolean
	lastJobActivityAt: string | null
	/** True when the jobs list failed. Do not treat that as "no jobs". */
	jobListingFailed?: boolean
	hasStrongRecentUse: boolean
	/** True when the execute rollup read failed. Do not treat that as 0 use. */
	executeReadFailed?: boolean
	isStripePaid: boolean
	isNearEntitlementCap: boolean
	/** Username used to mint the live referral share URL. */
	username?: string | null
	now: Date
}

export type UsageCampaignPersisted = {
	state: UsageCampaignState | null
	enteredAt: string | null
	sendCount: number
	lastSentAt: string | null
	origin: UsageCampaignOrigin | null
	coolingTerminal: boolean
	everActivated: boolean
	firstActivatedAt: string | null
	advocateSentAt: string | null
}

export type UsageCampaignAction = 'send' | 'silence' | 'persist'

export type UsageCampaignDecision = {
	state: UsageCampaignState
	action: UsageCampaignAction
	template: UsageCampaignMailTemplate | null
	sendIndex: number | null
	origin: UsageCampaignOrigin
	coolingTerminal: boolean
	everActivated: boolean
	reason: string
}

export function resolveUsageCampaignState(
	snapshot: UsageCampaignSnapshot,
	persisted: UsageCampaignPersisted,
): UsageCampaignState {
	if (snapshot.isStripePaid) return 'Paid'
	if (snapshot.isNearEntitlementCap) return 'LimitAware'

	const packaged = snapshot.firstSavedPackageAt != null

	if (
		packaged ||
		isActivatedOrCoolingHistory(persisted) ||
		persisted.everActivated
	) {
		if (snapshot.jobListingFailed && persisted.state === 'Activated') {
			return 'Activated'
		}
		if (snapshot.jobListingFailed && persisted.state === 'Cooling') {
			return 'Cooling'
		}
		if (isUsageCampaignQuiet(snapshot)) return 'Cooling'
		if (isActivatedUsage(snapshot)) return 'Activated'
		if (hasActivatedHistory(persisted)) {
			return 'Activated'
		}
		if (snapshot.inboundListingFailed) {
			if (packaged) return 'PackagedSingleClient'
			return 'Activated'
		}
		if (packaged && snapshot.distinctInboundClientCount < 2) {
			return 'PackagedSingleClient'
		}
		return 'Activated'
	}

	if (snapshot.firstMcpConnectedAt != null) return 'ConnectedNoPackage'
	return 'VerifiedNoMcp'
}

export function isUsageCampaignQuiet(snapshot: UsageCampaignSnapshot) {
	if (snapshot.hasEnabledScheduledJob) return false
	if (snapshot.lastActiveAt != null || snapshot.lastJobActivityAt != null) {
		return (
			isMissingOrStale(snapshot.lastActiveAt, snapshot.now) &&
			isMissingOrStale(snapshot.lastJobActivityAt, snapshot.now)
		)
	}
	return isStampStale(latestActivationStamp(snapshot), snapshot.now)
}

function latestActivationStamp(snapshot: UsageCampaignSnapshot) {
	let latest: string | null = null
	let latestTime = Number.NEGATIVE_INFINITY
	for (const stamp of [
		snapshot.firstSavedPackageAt,
		snapshot.firstMcpConnectedAt,
	]) {
		if (stamp == null) continue
		const at = Date.parse(stamp)
		if (!Number.isFinite(at) || at <= latestTime) continue
		latest = stamp
		latestTime = at
	}
	return latest
}

export function isActivatedUsage(snapshot: UsageCampaignSnapshot) {
	return (
		snapshot.hasEnabledScheduledJob ||
		snapshot.distinctInboundClientCount >= 2 ||
		snapshot.hasStrongRecentUse
	)
}

export function evaluateUsageCampaign(
	snapshot: UsageCampaignSnapshot,
	persisted: UsageCampaignPersisted,
): UsageCampaignDecision {
	if (snapshot.emailVerifiedAt == null) {
		throw new Error('Usage campaign evaluator requires a verified user')
	}

	const state = resolveUsageCampaignState(snapshot, persisted)
	if (persisted.state != null)
		usageCampaignState.parse(
			usageCampaignState.is(usageCampaignPhases[persisted.state])
				? usageCampaignPhases[state]
				: usageCampaignPhases[persisted.state],
		)
	const coolingTerminal =
		persisted.coolingTerminal ||
		(state === 'Cooling' &&
			persisted.state === 'Cooling' &&
			persisted.sendCount >= usageCampaignSendCaps.Cooling)
	const stateChanged = persisted.state !== state
	const origin: UsageCampaignOrigin = stateChanged
		? persisted.state == null
			? (persisted.origin ?? 'seed')
			: 'event'
		: (persisted.origin ?? 'seed')
	const sendCount = stateChanged ? 0 : persisted.sendCount
	const enteredAt = stateChanged
		? snapshot.now.toISOString()
		: (persisted.enteredAt ?? snapshot.now.toISOString())
	const lastSentAt = stateChanged ? null : persisted.lastSentAt
	const cap = usageCampaignSendCaps[state]
	const template = usageCampaignTemplateByState[state]
	const everActivated =
		persisted.everActivated ||
		marksActivatedHistory(state) ||
		(state === 'LimitAware' && isActivatedUsage(snapshot))

	if (state === 'PackagedSingleClient' && snapshot.inboundListingFailed) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			everActivated,
			reason: 'inbound_listing_failed',
		}
	}

	if (state === 'PackagedSingleClient' && snapshot.executeReadFailed) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			everActivated,
			reason: 'execute_read_failed',
		}
	}

	if (state === 'Cooling' && snapshot.jobListingFailed) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: coolingTerminal,
			everActivated,
			reason: 'job_listing_failed',
		}
	}

	if (cap === 0 || template == null) {
		const advocate = maybeAdvocateDecision({
			state,
			snapshot,
			persisted,
			origin,
			coolingTerminal,
			everActivated,
		})
		if (advocate) return advocate
		return {
			state,
			action: 'silence',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal,
			everActivated,
			reason: silenceReason(state),
		}
	}

	if (state === 'Cooling' && coolingTerminal) {
		return {
			state,
			action: 'silence',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: true,
			everActivated,
			reason: 'cooling_terminal',
		}
	}

	if (origin === 'seed') {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal,
			everActivated,
			reason: 'seed_no_backfill',
		}
	}

	if (sendCount >= cap) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal,
			everActivated,
			reason: 'cap_reached',
		}
	}

	if (
		sendCount === 0 &&
		!hasCompletedDwell(enteredAt, snapshot.now) &&
		!isImmediateFirstSend(state, persisted)
	) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			everActivated,
			reason: 'dwell',
		}
	}

	if (lastSentAt && !hasCompletedInterval(lastSentAt, snapshot.now)) {
		return {
			state,
			action: 'persist',
			template: null,
			sendIndex: null,
			origin,
			coolingTerminal: false,
			everActivated,
			reason: 'interval',
		}
	}

	return {
		state,
		action: 'send',
		template,
		sendIndex: sendCount + 1,
		origin,
		coolingTerminal: false,
		everActivated,
		reason: stateChanged ? 'entered' : 'nudge',
	}
}

function isActivatedOrCoolingHistory(persisted: UsageCampaignPersisted) {
	return (
		persisted.state === 'Activated' ||
		persisted.state === 'Cooling' ||
		persisted.state === 'PackagedSingleClient'
	)
}

function hasActivatedHistory(persisted: UsageCampaignPersisted) {
	return (
		persisted.everActivated ||
		persisted.state === 'Activated' ||
		persisted.state === 'Cooling' ||
		persisted.state === 'Paid'
	)
}

function marksActivatedHistory(state: UsageCampaignState) {
	return state === 'Activated' || state === 'Cooling' || state === 'Paid'
}

function isMissingOrStale(stamp: string | null, now: Date) {
	if (stamp == null) return true
	return isStampStale(stamp, now)
}

function isStampStale(stamp: string | null, now: Date) {
	if (stamp == null) return false
	const at = Date.parse(stamp)
	if (!Number.isFinite(at)) return false
	return now.getTime() - at >= usageCampaignCoolingStaleMs
}

function hasCompletedDwell(enteredAt: string, now: Date) {
	const at = Date.parse(enteredAt)
	if (!Number.isFinite(at)) return false
	return now.getTime() - at >= usageCampaignFirstSendDwellMs
}

function hasCompletedInterval(lastSentAt: string, now: Date) {
	const at = Date.parse(lastSentAt)
	if (!Number.isFinite(at)) return false
	return now.getTime() - at >= usageCampaignSendIntervalMs
}

/**
 * Verify-time VerifiedNoMcp send 1 is recorded as an event-origin row with
 * no prior send. The verify handler sends immediately; the evaluator used
 * from that path treats the first send as due. A later VerifiedNoMcp
 * re-entry (for example leaving LimitAware) still waits out the dwell so
 * it cannot retry ledger send 1 the same hour.
 */
function isImmediateFirstSend(
	state: UsageCampaignState,
	persisted: UsageCampaignPersisted,
) {
	return (
		state === 'VerifiedNoMcp' &&
		persisted.state == null &&
		persisted.origin === 'event'
	)
}

export function nextUsageCampaignRow(input: {
	decision: UsageCampaignDecision
	persisted: UsageCampaignPersisted
	now: Date
	sent: boolean
}) {
	const stateChanged = input.persisted.state !== input.decision.state
	const enteredAt = stateChanged
		? input.now.toISOString()
		: (input.persisted.enteredAt ?? input.now.toISOString())
	const advocateSend =
		input.sent && isAdvocateCampaignTemplate(input.decision.template)
	const sendCount = advocateSend
		? stateChanged
			? 0
			: input.persisted.sendCount
		: input.sent
			? stateChanged
				? 1
				: input.persisted.sendCount + 1
			: stateChanged
				? 0
				: input.persisted.sendCount
	const lastSentAt = advocateSend
		? stateChanged
			? null
			: input.persisted.lastSentAt
		: input.sent
			? input.now.toISOString()
			: stateChanged
				? null
				: input.persisted.lastSentAt
	if (input.persisted.state != null)
		usageCampaignState.parse(
			usageCampaignState.is(usageCampaignPhases[input.persisted.state])
				? usageCampaignPhases[input.decision.state]
				: usageCampaignPhases[input.persisted.state],
		)
	const everActivated =
		input.persisted.everActivated ||
		input.decision.everActivated ||
		marksActivatedHistory(input.decision.state)
	return {
		state: input.decision.state,
		enteredAt,
		sendCount,
		lastSentAt,
		origin: input.decision.origin,
		coolingTerminal:
			input.persisted.coolingTerminal ||
			input.decision.coolingTerminal ||
			(input.sent && input.decision.state === 'Cooling'),
		everActivated,
		firstActivatedAt: nextFirstActivatedAt({
			persisted: input.persisted,
			everActivated,
			now: input.now,
		}),
		advocateSentAt:
			input.persisted.advocateSentAt ??
			(advocateSend ? input.now.toISOString() : null),
	}
}

function maybeAdvocateDecision(input: {
	state: UsageCampaignState
	snapshot: UsageCampaignSnapshot
	persisted: UsageCampaignPersisted
	origin: UsageCampaignOrigin
	coolingTerminal: boolean
	everActivated: boolean
}): UsageCampaignDecision | null {
	if (input.state !== 'Activated' && input.state !== 'Paid') return null
	if (input.persisted.advocateSentAt != null) return null
	if (input.persisted.state == null) return null
	const username = input.snapshot.username?.trim() ?? ''
	if (username === '') return null
	const tenureStart =
		input.persisted.firstActivatedAt ?? input.persisted.enteredAt
	if (tenureStart == null) return null
	const tenureAt = Date.parse(tenureStart)
	if (!Number.isFinite(tenureAt)) return null
	if (
		input.snapshot.now.getTime() - tenureAt <
		usageCampaignAdvocateMinTenureMs
	) {
		return null
	}
	return {
		state: input.state,
		action: 'send',
		template: 'advocate_referral_testimonial',
		sendIndex: usageCampaignAdvocateSendIndex,
		origin: input.origin,
		coolingTerminal: input.coolingTerminal,
		everActivated: input.everActivated,
		reason: 'advocate_one_shot',
	}
}

function nextFirstActivatedAt(input: {
	persisted: UsageCampaignPersisted
	everActivated: boolean
	now: Date
}) {
	if (input.persisted.firstActivatedAt) return input.persisted.firstActivatedAt
	if (!input.everActivated) return null
	if (
		input.persisted.state === 'Activated' ||
		input.persisted.state === 'Cooling' ||
		input.persisted.state === 'Paid'
	) {
		return input.persisted.enteredAt ?? input.now.toISOString()
	}
	return input.now.toISOString()
}

function silenceReason(state: UsageCampaignState) {
	switch (state) {
		case 'Activated':
			return 'activated_silence'
		case 'Paid':
			return 'paid_silence'
		case 'LimitAware':
			return 'limit_aware_transactional'
		case 'VerifiedNoMcp':
		case 'ConnectedNoPackage':
		case 'PackagedSingleClient':
		case 'Cooling':
			return 'no_template'
		default: {
			const exhaustive: never = state
			throw new Error(`Unknown campaign state: ${String(exhaustive)}`)
		}
	}
}
