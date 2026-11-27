import type { SessionStuckKind } from '#universal/session-analytics.ts'

/**
 * Fixed next-step text per error kind. Kinds without a clear next step have
 * no entry and get no nudge. No model and no data from another session.
 */
const nudgeNextSteps: Partial<Record<SessionStuckKind, string>> = {
	credential_missing:
		'connect the service or save the secret first, then retry.',
	credential_denied:
		'ask the person to allow this credential for the host or capability, then retry.',
	validation:
		'reread the input schema for this call and change the arguments before retrying.',
	not_found:
		'search for the right name or id instead of retrying the same one.',
	entitlement:
		'this is a plan or usage limit, so tell the person instead of retrying.',
	timeout:
		'split the work into smaller calls or move it to a job instead of retrying as is.',
}

const nudgeReasons: Partial<Record<SessionStuckKind, string>> = {
	credential_missing: 'a missing credential',
	credential_denied: 'a credential that is not allowed here',
	validation: 'invalid input',
	not_found: 'something that was not found',
	entitlement: 'a plan limit',
	timeout: 'a timeout',
}

/**
 * The one line added to a repeated failure, or null. `priorStreak` is how
 * many times this tool already failed with this kind, in a row, in the same
 * session before the current call.
 */
export function sessionNudgeLine(input: {
	stuckKind: SessionStuckKind
	priorStreak: number
}): string | null {
	if (input.priorStreak < 1) return null
	const nextStep = nudgeNextSteps[input.stuckKind]
	const reason = nudgeReasons[input.stuckKind]
	if (!nextStep || !reason) return null
	const times = input.priorStreak + 1
	return `Kody note: this call has now failed ${String(times)} times in a row for ${reason}. Next step: ${nextStep}`
}
