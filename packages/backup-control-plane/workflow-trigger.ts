import { workflowInstanceId } from './backup-policy.ts'
import type { ScheduledBackupPayload } from './backup-types.ts'

export type WorkflowInstanceStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'errored'
	| 'terminated'
	| 'complete'
	| 'waiting'
	| 'waitingForPause'
	| 'rollingBack'
	| 'unknown'

export type EnqueueResult = 'created' | 'duplicate' | 'restarted'

interface WorkflowHandle {
	status(): Promise<{ status: WorkflowInstanceStatus }>
	restart(): Promise<void>
}

interface WorkflowStarter<Params> {
	create(options: { id: string; params: Params }): Promise<unknown>
	get(id: string): Promise<WorkflowHandle>
}

export type RetryTickResult = EnqueueResult | 'outside-window'

export function isApprovedRetryWindow(scheduledAt: Date): boolean {
	const hour = scheduledAt.getUTCHours()
	return scheduledAt.getUTCMinutes() === 45 && hour >= 2 && hour <= 5
}

export function primaryBackupTimeForDay(scheduledAt: Date): Date {
	return new Date(
		Date.UTC(
			scheduledAt.getUTCFullYear(),
			scheduledAt.getUTCMonth(),
			scheduledAt.getUTCDate(),
			2,
			15,
		),
	)
}

export async function enqueueWorkflow<Params>(
	workflow: WorkflowStarter<Params>,
	id: string,
	params: Params,
): Promise<EnqueueResult> {
	try {
		await workflow.create({ id, params })
		return 'created'
	} catch (createError) {
		let instance: WorkflowHandle
		try {
			instance = await workflow.get(id)
		} catch {
			// Preserve the original create failure when no instance can be proven.
			throw createError
		}
		const status = await instance.status()
		switch (status.status) {
			case 'queued':
			case 'running':
			case 'paused':
			case 'complete':
			case 'waiting':
			case 'waitingForPause':
			case 'rollingBack':
				return 'duplicate'
			case 'errored':
			case 'terminated':
				await instance.restart()
				return 'restarted'
			case 'unknown':
				throw createError
			default: {
				const exhaustive: never = status.status
				void exhaustive
				throw createError
			}
		}
	}
}

export async function enqueueBackup(
	workflow: WorkflowStarter<ScheduledBackupPayload>,
	databaseId: string,
	payload: ScheduledBackupPayload,
): Promise<EnqueueResult> {
	return enqueueWorkflow(
		workflow,
		workflowInstanceId(databaseId, payload.day),
		payload,
	)
}

export async function enqueueBackupRetry(
	workflow: WorkflowStarter<ScheduledBackupPayload>,
	databaseId: string,
	payload: ScheduledBackupPayload,
	scheduledAt: Date,
): Promise<RetryTickResult> {
	if (!isApprovedRetryWindow(scheduledAt)) return 'outside-window'
	return enqueueBackup(workflow, databaseId, payload)
}
