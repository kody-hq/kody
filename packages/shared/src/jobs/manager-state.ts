import type {
	JobManagerDebugState,
	JobManagerDebugStatus,
} from './manager-debug.ts'

export function resolveJobManagerAlarmState(input: {
	alarmTimestamp: number | null
	nextRunnableRunAt: string | null
}): Pick<JobManagerDebugState, 'alarmScheduledFor' | 'alarmInSync' | 'status'> {
	const alarmScheduledFor =
		typeof input.alarmTimestamp === 'number'
			? new Date(input.alarmTimestamp).toISOString()
			: null
	const nextRunnableMs =
		input.nextRunnableRunAt == null
			? null
			: new Date(input.nextRunnableRunAt).valueOf()
	const alarmMs =
		typeof input.alarmTimestamp === 'number' ? input.alarmTimestamp : null
	const timestampsMatch =
		nextRunnableMs != null &&
		alarmMs != null &&
		Number.isFinite(nextRunnableMs) &&
		alarmMs === nextRunnableMs
	const alarmInSync = nextRunnableMs == null ? alarmMs == null : timestampsMatch
	const status: JobManagerDebugStatus =
		nextRunnableMs == null
			? alarmMs == null
				? 'idle'
				: 'out_of_sync'
			: timestampsMatch
				? 'armed'
				: 'out_of_sync'

	return {
		alarmScheduledFor,
		alarmInSync,
		status,
	}
}
