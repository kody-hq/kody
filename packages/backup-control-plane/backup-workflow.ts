import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

import { runBackupRuntime, type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type ScheduledBackupWorkflowPayload,
} from './backup-types.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'
import { nonRetryableBackupError } from './workflow-terminal-error.ts'

export class ProductionD1BackupWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	ScheduledBackupWorkflowPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<ScheduledBackupWorkflowPayload>>,
		step: WorkflowStep,
	) {
		try {
			const runtimeStep = withNonRetryableBackupErrors(
				step as unknown as BackupRuntimeStep,
			)
			return await runBackupRuntime(this.env, event, runtimeStep)
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw nonRetryableBackupError(error)
			}
			throw error
		}
	}
}
