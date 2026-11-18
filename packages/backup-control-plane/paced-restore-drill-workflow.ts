import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'

import type { BackupEnvironment } from './backup-types.ts'
import {
	runPacedRestoreDrill,
	type PacedDrillPayload,
	type PacedDrillProgress,
	type PacedDrillStep,
} from './paced-restore-drill.ts'
import { withRetryingBackupBucket } from './r2-retry.ts'

export class PacedRestoreDrillWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	PacedDrillPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<PacedDrillPayload>>,
		step: WorkflowStep,
	): Promise<PacedDrillProgress> {
		return runPacedRestoreDrill({
			env: withRetryingBackupBucket(this.env),
			payload: event.payload,
			step: step as unknown as PacedDrillStep,
		})
	}
}
