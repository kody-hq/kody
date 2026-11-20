import * as Sentry from '@sentry/cloudflare'
import {
	BackupError,
	errorCode,
	isBackupEnabled,
	safeLog,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'
import { sealRecentCompleteDays } from './seal-full-backup.ts'
import { buildControlPlaneSentryOptions } from './sentry.ts'
import { withRetryingBackupBucket } from './r2-retry.ts'

export { ProductionDrRestoreWorkflow } from './restore-workflow.ts'
export { ProductionSealDayWorkflow } from './seal-day-workflow.ts'
export { PacedRestoreDrillWorkflow } from './paced-restore-drill-workflow.ts'

export const SEAL_CRON = '45 * * * *'

async function scheduled(
	controller: ScheduledController,
	env: BackupEnvironment,
): Promise<void> {
	if (!isBackupEnabled(env)) {
		safeLog({
			event: 'backup-disabled',
			status: 'disabled',
			errorCode: 'explicit-enable-or-benchmark-approval-missing',
		})
		return
	}
	const scheduledAt = new Date(controller.scheduledTime)
	switch (controller.cron) {
		case SEAL_CRON:
			// Raw bucket: the seal scan budgets its own calls and retries.
			await sealRecentCompleteDays(env, scheduledAt)
			return
		default:
			throw new BackupError(
				'unknown-schedule',
				`unexpected cron trigger: ${controller.cron}`,
			)
	}
}

const handler = {
	async fetch(request: Request, env: BackupEnvironment): Promise<Response> {
		return handleControlPlaneFetch(request, withRetryingBackupBucket(env))
	},
	async scheduled(
		controller: ScheduledController,
		env: BackupEnvironment,
	): Promise<void> {
		try {
			await scheduled(controller, env)
		} catch (error) {
			safeLog({
				event: 'backup-failure',
				status: 'failure',
				errorCode: errorCode(error),
			})
			throw error
		}
	},
} satisfies ExportedHandler<BackupEnvironment>

export default Sentry.withSentry(
	(env: BackupEnvironment) => buildControlPlaneSentryOptions(env),
	handler,
)
