import { readDrBackupS3Config } from '#worker/dr/backup-s3.ts'

/**
 * Shadow paced D1 backup shares the nightly DR export window so both lanes
 * drain during the same low-traffic hours. Roughly 00:30–06:10 UTC on the
 * every-5-minute cron (~68 ticks × 45 s). Outside the window, catch-up resumes
 * incomplete nights under the same budget.
 */
export function shouldRunD1PacedBackupCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 30 && minutes <= 6 * 60 + 10
}

/** How many prior UTC days catch-up / watchdog scan for unfinished nights. */
export const d1PacedBackupCatchUpLookbackDays = 14

/**
 * Daytime catch-up: every worker cron tick outside the nightly window resumes
 * the oldest incomplete paced night in the lookback.
 */
export function shouldRunD1PacedBackupCatchUpCron(now: Date) {
	if (shouldRunD1PacedBackupCron(now)) return false
	return now.getUTCMinutes() % 5 === 0
}

/**
 * One cron tick after the window closes (06:15–06:19 UTC). Fails loudly when
 * tonight's paced staging manifests are still missing.
 */
export function shouldRunD1PacedBackupWatchdogCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 6 * 60 + 15 && minutes < 6 * 60 + 20
}

/**
 * Gate: literal `"true"` plus the same DR S3 credentials as `DR_EXPORT`.
 * Source list (`DR_D1_PACED_SOURCES`) is validated at tick time.
 */
export function isD1PacedBackupConfigured(
	env: Pick<
		Env,
		| 'DR_D1_PACED_BACKUP_ENABLED'
		| 'DR_BACKUP_ACCOUNT_ID'
		| 'DR_BACKUP_BUCKET_NAME'
		| 'DR_BACKUP_ACCESS_KEY_ID'
		| 'DR_BACKUP_SECRET_ACCESS_KEY'
	>,
) {
	return (
		env.DR_D1_PACED_BACKUP_ENABLED?.trim() === 'true' &&
		readDrBackupS3Config(env) !== null
	)
}
