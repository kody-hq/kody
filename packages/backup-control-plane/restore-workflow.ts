import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	runProductionRestore,
	restoreProgressFailsWorkflow,
	type ProductionRestorePayload,
	type ProductionRestoreProgress,
} from './production-restore.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'
import { nonRetryableBackupError } from './workflow-terminal-error.ts'

export class ProductionDrRestoreWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	ProductionRestorePayload
> {
	override async run(
		event: Readonly<WorkflowEvent<ProductionRestorePayload>>,
		step: WorkflowStep,
	): Promise<ProductionRestoreProgress> {
		try {
			const runtimeStep = withNonRetryableBackupErrors(
				step as unknown as BackupRuntimeStep,
			)
			const progress = await runtimeStep.do(
				'run-production-restore',
				async () => runProductionRestore(this.env, event.payload),
			)
			// Persist progress (including warnings) as step output, then fail the
			// workflow instance when restore finished with any dr-restore warnings.
			// Informational notes (undeclared historical databases) are not failures.
			if (restoreProgressFailsWorkflow(progress)) {
				const code = progress.errorCode ?? 'dr-restore-warnings'
				throw nonRetryableBackupError({
					code,
					message:
						progress.errorMessage ??
						'production restore completed with warnings',
				})
			}
			return progress
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw nonRetryableBackupError(error)
			}
			throw error
		}
	}
}
