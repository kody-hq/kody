import { readDrBackupS3Config } from '#worker/dr/backup-s3.ts'

/**
 * Nightly DR export window: roughly 00:30–06:10 UTC on the worker's
 * every-5-minute cron (~68 ticks × 45 s ≈ 51 minutes of staging work).
 * Ticks outside this window are skipped so daytime traffic is not competing
 * with a full-platform export. Inside the window, each tick prefers the
 * oldest stranded day in the lookback (progress without summary), then today.
 * Completed days exit cheaply through the summary-object check.
 */
export function shouldRunDrExportCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 30 && minutes <= 6 * 60 + 10
}

/**
 * How many days before today the daytime catch-up (and the watchdog's
 * stuck-day check) scan for stranded staging: a day whose
 * `exporter/progress.json` exists but whose `exporter/summary.json` was never
 * written because the nightly window closed first.
 *
 * Sized for the 2026-09 lookback failure and the 2026-10 pace, when ~700
 * Mailbox owners took ~28h of wall clock per staged day. Owner export now
 * waves 8 Durable Object reads inside a 45s tick so a day should finish
 * inside 24h, but the 14-day window stays: a regression must not age a day
 * out mid-phase the way 2026-09-12..2026-09-22 did under a 2-day lookback.
 * Keep in sync with `sealRecentCompleteDays` so a newly written summary is
 * still within the hourly seal scan.
 */
export const drExportCatchUpLookbackDays = 14

/**
 * Daytime catch-up cadence: outside the nightly window, every worker cron
 * tick (every 5 minutes) resumes the oldest stranded day in the lookback
 * until its summary is written. A single tick still spends at most the
 * normal ~45 s budget, so daytime blast radius stays bounded while backlog
 * drains ~3× faster than the previous 15-minute cadence. Ticks with no
 * stranded day exit after two cheap HEAD-style checks per lookback day.
 */
export function shouldRunDrExportCatchUpCron(now: Date) {
	if (shouldRunDrExportCron(now)) return false
	return now.getUTCMinutes() % 5 === 0
}

/**
 * One cron tick after the export window closes (06:15–06:19 UTC). The
 * watchdog fails loudly (lane failure → Sentry) when the night's staging
 * summary is missing, because the exporter itself never errors when it
 * merely runs out of window.
 */
export function shouldRunDrExportWatchdogCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 6 * 60 + 15 && minutes < 6 * 60 + 20
}

export function isDrExportConfigured(
	env: Pick<
		Env,
		| 'DR_EXPORT_ENABLED'
		| 'DR_BACKUP_ACCOUNT_ID'
		| 'DR_BACKUP_BUCKET_NAME'
		| 'DR_BACKUP_ACCESS_KEY_ID'
		| 'DR_BACKUP_SECRET_ACCESS_KEY'
	>,
) {
	return (
		env.DR_EXPORT_ENABLED?.trim() === 'true' &&
		readDrBackupS3Config(env) !== null
	)
}
