import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
} from '#mcp/capabilities/jobs/shared.ts'
import { type JobManagerDebugState } from '#worker/jobs/manager-client.ts'
import { inspectJobsForUser } from '#worker/jobs/inspect.ts'
import { requirePackageIdFromJobId } from '#worker/jobs/package-job-id.ts'
import { type JobSchedule, type JobView } from '#worker/jobs/types.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { highlightJsonValue } from '#app/highlight-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountJobListItem = {
	id: string
	name: string
	packageId: string
	packageName: string | null
	packageKodyId: string | null
	scheduleSummary: string
	scheduleType: JobSchedule['type']
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	expiresAt: string | null
	expired: boolean
	dueNow: boolean
	lastRunStatus: 'success' | 'error' | null
	nextRunAt: string
	lastRunAt: string | null
	runCount: number
	successCount: number
	errorCount: number
}

export type AccountJobRecentRun = {
	id: string
	startedAt: string
	finishedAt: string
	status: 'success' | 'error' | 'running'
	durationMs: number
	error: string | null
}

export type AccountJobSchedule = JobSchedule

export type AccountJobDetail = AccountJobListItem & {
	params: Record<string, unknown> | null
	paramsHighlighted?: HighlightedCode
	schedule: AccountJobSchedule
	lastRunError: string | null
	lastDurationMs: number | null
	recentRuns: Array<AccountJobRecentRun>
	storageId: string
	sourceId: string
	publishedCommit: string | null
	createdAt: string
	updatedAt: string
}

export type AccountJobsAlarm = {
	bindingAvailable: boolean
	status: JobManagerDebugState['status']
	storedUserId: string | null
	alarmScheduledFor: string | null
	nextRunnableJobId: string | null
	nextRunnableRunAt: string | null
	alarmInSync: boolean | null
}

export type AccountJobsLoaderData = {
	ok: true
	username: string
	jobs: Array<AccountJobListItem>
	selectedJob: AccountJobDetail | null
	selectedJobId: string | null
	alarm?: AccountJobsAlarm
}

const accountJobsBasePath = '/account/jobs'
const recentRunsLimit = 20

export function readAccountJobsSelectedJobId(
	requestUrl: string,
	pathJobId?: string,
) {
	if (pathJobId?.trim()) return pathJobId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountJobsBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const jobId = decodeURIComponent(segment)
				if (jobId) return jobId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

function toListItem(
	job: JobView,
	packagesById: ReadonlyMap<string, { name: string; kodyId: string }>,
	inspection = buildJobInspectionOutput(job),
): AccountJobListItem {
	const packageId = requirePackageIdFromJobId(job.id)
	const savedPackage = packagesById.get(packageId)
	return {
		id: job.id,
		name: job.name,
		packageId,
		packageName: savedPackage?.name ?? null,
		packageKodyId: savedPackage?.kodyId ?? null,
		scheduleSummary: job.scheduleSummary,
		scheduleType: job.schedule.type,
		timezone: job.timezone,
		enabled: job.enabled,
		killSwitchEnabled: job.killSwitchEnabled,
		expiresAt: inspection.expires_at,
		expired: inspection.expired,
		dueNow: inspection.due_now,
		lastRunStatus: job.lastRunStatus ?? null,
		nextRunAt: job.nextRunAt,
		lastRunAt: job.lastRunAt ?? null,
		runCount: job.runCount,
		successCount: job.successCount,
		errorCount: job.errorCount,
	}
}

async function loadRecentRunsForJob(input: {
	env: Env
	userId: OwnerId
	jobId: string
}): Promise<Array<AccountJobRecentRun>> {
	const page = await listRunRecords({
		env: input.env,
		userId: input.userId,
		filter: { jobId: input.jobId },
		limit: recentRunsLimit,
	})
	return page.runs.map((run) => ({
		id: run.id,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt ?? run.startedAt,
		status: run.status,
		durationMs: run.durationMs ?? 0,
		error: run.errorMessage,
	}))
}

async function toDetail(input: {
	env: Env
	userId: OwnerId
	job: JobView
	packagesById: ReadonlyMap<string, { name: string; kodyId: string }>
	serverTiming?: Array<ServerTimingEntry>
}): Promise<AccountJobDetail> {
	const inspection = buildJobInspectionOutput(input.job)
	const recentRuns = await loadRecentRunsForJob({
		env: input.env,
		userId: input.userId,
		jobId: input.job.id,
	})
	return {
		...toListItem(input.job, input.packagesById, inspection),
		params: input.job.params ?? null,
		paramsHighlighted: await highlightJsonValue(
			input.env,
			input.job.params ?? {},
			{ serverTiming: input.serverTiming },
		),
		schedule: input.job.schedule,
		lastRunError: input.job.lastRunError ?? null,
		lastDurationMs: input.job.lastDurationMs ?? null,
		recentRuns,
		storageId: input.job.storageId,
		sourceId: input.job.sourceId,
		publishedCommit: input.job.publishedCommit,
		createdAt: input.job.createdAt,
		updatedAt: input.job.updatedAt,
	}
}

function toAlarm(state: JobManagerDebugState): AccountJobsAlarm {
	const debug = buildJobManagerDebugOutput(state, { kind: 'all' })
	return {
		bindingAvailable: debug.binding_available,
		status: debug.status,
		storedUserId: debug.stored_user_id,
		alarmScheduledFor: debug.alarm_scheduled_for,
		nextRunnableJobId: debug.next_runnable_job_id,
		nextRunnableRunAt: debug.next_runnable_run_at,
		alarmInSync: debug.alarm_in_sync,
	}
}

export async function loadAccountJobsData(input: {
	env: Env
	user: AuthenticatedUser
	selectedJobId: string | null
	serverTiming?: Array<ServerTimingEntry>
}): Promise<AccountJobsLoaderData> {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const selectedJobId = input.selectedJobId
	const [inspection, savedPackages] = await Promise.all([
		inspectJobsForUser({
			env: input.env,
			userId,
		}),
		listSavedPackagesByUserId(input.env.APP_DB, { userId }),
	])
	const packagesById = new Map(
		savedPackages.map((savedPackage) => [
			savedPackage.id,
			{ name: savedPackage.name, kodyId: savedPackage.kodyId },
		]),
	)
	const selectedRecord = selectedJobId
		? (inspection.jobs.find((job) => job.id === selectedJobId) ?? null)
		: null

	return {
		ok: true,
		username: input.user.username,
		jobs: inspection.jobs.map((job) => toListItem(job, packagesById)),
		selectedJob: selectedRecord
			? await toDetail({
					env: input.env,
					userId,
					job: selectedRecord,
					packagesById,
					serverTiming: input.serverTiming,
				})
			: null,
		selectedJobId,
		alarm: toAlarm(inspection.alarm),
	}
}
