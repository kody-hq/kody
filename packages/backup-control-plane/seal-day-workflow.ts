import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import { runSealDay } from './seal-day-run.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'
import { nonRetryableBackupError } from './workflow-terminal-error.ts'

type SealDayWorkflowPayload = {
	day: string
}

export class ProductionSealDayWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	SealDayWorkflowPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<SealDayWorkflowPayload>>,
		step: WorkflowStep,
	) {
		try {
			const runtimeStep = withNonRetryableBackupErrors(
				step as unknown as BackupRuntimeStep,
			)
			return await runSealDay(this.env, event.payload.day, runtimeStep)
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw nonRetryableBackupError(error)
			}
			throw error
		}
	}
}
