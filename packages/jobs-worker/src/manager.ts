import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type JobManagerDebugState } from '@kody-internal/shared/jobs/manager-debug.ts'
import {
	type JobExecutionResult,
	type JobRepoCheckPolicy,
	type JobView,
} from '@kody-internal/shared/jobs/types.ts'
import { type JobsWorkerEnv } from './env.ts'

type JobManagerRpc = {
	purgeUser: (payload: { userId: string }) => Promise<{
		ok: true
		userId: string
	}>
	exportUser: (payload: { userId: string }) => Promise<JobManagerDebugState>
	syncAlarm: (payload: {
		userId: string
		source?: 'alarm' | 'rpc' | 'run_now'
	}) => Promise<{
		ok: true
		userId: string
		nextRunAt: string | null
	}>
	getDebugState: (payload: { userId: string }) => Promise<JobManagerDebugState>
	runNow: (payload: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}) => Promise<{
		job: JobView
		execution: JobExecutionResult
	}>
}

/**
 * Frozen id contract: one JobManager per user, named by the raw owner id.
 * Mirrors `jobManagerDurableObjectName` in the main worker. Do not trim:
 * existing objects were named with the stored id bytes.
 */
export function jobManagerStub(
	env: JobsWorkerEnv,
	userId: OwnerId,
): JobManagerRpc {
	return env.JOB_MANAGER.get(
		env.JOB_MANAGER.idFromName(userId),
	) as unknown as JobManagerRpc
}
