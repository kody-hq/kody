import * as Sentry from '@sentry/cloudflare'
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

import { runBackupRuntime, type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import type {
	BackupEnvironment,
	ScheduledBackupWorkflowPayload,
} from './backup-types.ts'
import { buildControlPlaneSentryOptions } from './sentry.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'
import { nonRetryableBackupError } from './workflow-terminal-error.ts'

class ProductionD1BackupWorkflowBase extends WorkflowEntrypoint<
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

export const ProductionD1BackupWorkflow = Sentry.instrumentWorkflowWithSentry(
	(env: BackupEnvironment) => buildControlPlaneSentryOptions(env),
	ProductionD1BackupWorkflowBase,
)
