/**
 * Saved `disabled_reason` text for jobs Kody turns off on its own. Kept in one
 * place so the job row, the owner notice, and the on/off audit trail say the
 * same thing.
 */
export const jobExpiredDisabledReason = 'The job passed its expiry time.'

export const oneTimeJobFinishedReason = 'The one-time job finished its run.'

export function rescheduleFailedDisabledReason(
	rescheduleError: string | null | undefined,
) {
	return `Kody could not compute the next run from the job's schedule${rescheduleError ? ` (${rescheduleError})` : ''}.`
}

export const offboardingDisabledReason =
	'Canceled when its creator was removed from the org.'
