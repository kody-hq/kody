/**
 * Repair package job rows whose stored caller context lost
 * `storageContext.packageId` (typically after Run now persisted the clicker's
 * interactive context). Rebuilds the blob the same way package publish does
 * via `createPackageJobCallerContext`.
 */

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { packageIdFromJobId } from '@kody-internal/shared/jobs/package-job-id.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { jobsData, type JobsDataEnv } from './jobs-data.ts'
import {
	createPackageJobCallerContext,
	serializeCallerContext,
} from './service.ts'

const defaultBackfillLimit = 100
const maxBackfillLimit = 500

export const jobCallerContextPackageIdBackfillLimitDefault =
	defaultBackfillLimit
export const jobCallerContextPackageIdBackfillLimitMax = maxBackfillLimit

export type JobCallerContextPackageIdBackfillRowOutcome =
	| 'repaired'
	| 'already_ok'
	| 'skipped_bad_job_id'
	| 'skipped_deleted'
	| 'failed'

export type JobCallerContextPackageIdBackfillCounts = {
	scanned: number
	repaired: number
	alreadyOk: number
	skippedBadJobId: number
	skippedDeleted: number
	failed: number
}

export type JobCallerContextPackageIdBackfillOutcome = {
	jobId: string
	orgId: string
	packageId: string | null
	outcome: JobCallerContextPackageIdBackfillRowOutcome
	error?: string
}

export type JobCallerContextPackageIdBackfillResult = {
	dryRun: boolean
	counts: JobCallerContextPackageIdBackfillCounts
	nextCursor: string | null
	outcomes: Array<JobCallerContextPackageIdBackfillOutcome>
}

function parseStoredCallerContextJson(callerContextJson: string): {
	packageId: string | null
	baseUrl: string | null
} {
	try {
		const parsed = JSON.parse(callerContextJson) as {
			baseUrl?: unknown
			storageContext?: { packageId?: unknown }
		}
		const packageIdRaw = parsed.storageContext?.packageId
		// Keep the raw stored string for equality checks; only treat
		// blank/whitespace as missing.
		const packageId =
			typeof packageIdRaw === 'string' && packageIdRaw.trim() !== ''
				? packageIdRaw
				: null
		const baseUrlRaw = parsed.baseUrl
		const baseUrl =
			typeof baseUrlRaw === 'string' && baseUrlRaw.trim() !== ''
				? baseUrlRaw.trim()
				: null
		return { packageId, baseUrl }
	} catch {
		return { packageId: null, baseUrl: null }
	}
}

export function jobCallerContextNeedsPackageIdRepair(input: {
	jobId: string
	callerContextJson: string
}): { needsRepair: boolean; packageId: string | null } {
	const packageId = packageIdFromJobId(input.jobId)
	if (!packageId) return { needsRepair: false, packageId: null }
	const stored = parseStoredCallerContextJson(input.callerContextJson).packageId
	return {
		needsRepair: stored !== packageId,
		packageId,
	}
}

/**
 * Idempotent page over package jobs missing (or mismatched)
 * `storageContext.packageId`. dryRun counts would-be repairs without writing.
 */
export async function backfillJobCallerContextPackageIds(input: {
	env: JobsDataEnv & { APP_DB: D1Database }
	dryRun?: boolean
	limit?: number
	cursor?: string | null
	baseUrl?: string
}): Promise<JobCallerContextPackageIdBackfillResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.min(
		Math.max(1, input.limit ?? defaultBackfillLimit),
		maxBackfillLimit,
	)
	const cursor = input.cursor ?? null
	const baseUrl =
		input.baseUrl?.trim() ||
		getAppBaseUrl({ env: input.env as Env, requestUrl: null })

	const page = await jobsData(input.env).listJobsPage({
		afterId: cursor,
		limit,
	})

	const counts: JobCallerContextPackageIdBackfillCounts = {
		scanned: page.length,
		repaired: 0,
		alreadyOk: 0,
		skippedBadJobId: 0,
		skippedDeleted: 0,
		failed: 0,
	}
	const outcomes: Array<JobCallerContextPackageIdBackfillOutcome> = []

	for (const row of page) {
		const orgId = String(row.user_id)
		const jobId = row.id
		try {
			if (row.deleted_at != null) {
				counts.skippedDeleted += 1
				outcomes.push({
					jobId,
					orgId,
					packageId: null,
					outcome: 'skipped_deleted',
				})
				continue
			}

			const { needsRepair, packageId } = jobCallerContextNeedsPackageIdRepair({
				jobId,
				callerContextJson: row.caller_context_json,
			})
			if (!packageId) {
				counts.skippedBadJobId += 1
				outcomes.push({
					jobId,
					orgId,
					packageId: null,
					outcome: 'skipped_bad_job_id',
				})
				continue
			}
			if (!needsRepair) {
				counts.alreadyOk += 1
				outcomes.push({
					jobId,
					orgId,
					packageId,
					outcome: 'already_ok',
				})
				continue
			}

			if (dryRun) {
				counts.repaired += 1
				outcomes.push({
					jobId,
					orgId,
					packageId,
					outcome: 'repaired',
				})
				continue
			}

			const storedBaseUrl = parseStoredCallerContextJson(
				row.caller_context_json,
			).baseUrl
			const callerContext = await createPackageJobCallerContext({
				env: input.env as Env,
				db: input.env.APP_DB,
				// Keep the job's published origin when present so credential
				// failure URLs stay on the same host the package was synced for.
				baseUrl: storedBaseUrl || baseUrl,
				userId: ownerIdFromStored(orgId),
				packageId,
			})
			const updatedAt = new Date().toISOString()
			const didUpdate = await jobsData(input.env).updateJobCallerContextJson({
				userId: ownerIdFromStored(orgId),
				jobId,
				expectedCallerContextJson: row.caller_context_json,
				callerContextJson: serializeCallerContext(callerContext),
				updatedAt,
			})
			if (!didUpdate) {
				throw new Error(
					`Job "${jobId}" caller context changed concurrently; re-run the backfill page.`,
				)
			}
			counts.repaired += 1
			outcomes.push({
				jobId,
				orgId,
				packageId,
				outcome: 'repaired',
			})
		} catch (error) {
			counts.failed += 1
			outcomes.push({
				jobId,
				orgId,
				packageId: packageIdFromJobId(jobId),
				outcome: 'failed',
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const last = page.at(-1)
	return {
		dryRun,
		counts,
		nextCursor: page.length === limit && last ? last.id : null,
		outcomes,
	}
}
