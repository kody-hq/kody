import type { JobRecord } from '@kody-internal/shared/jobs/types.ts'
import {
	resolvePackageForProvenance,
	type PackageProvenanceTarget,
} from '#worker/admin/package-provenance.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import {
	servingArtifactCommitForSource,
	servingCommitForSource,
} from '#worker/repo/serving-commit.ts'

export type JobAttributionRepairRefusal =
	| 'source_not_found'
	| 'job_not_found'
	| 'job_not_in_package'
	| 'serving_commit_unavailable'
	| 'serving_commit_mismatch'
	| 'publish_in_progress'
	| 'recorded_commit_mismatch'
	| 'write_conflict'
	| 'source_changed_during_apply'

export type JobAttributionRepairResult = {
	mode: 'dry_run' | 'apply'
	outcome: 'would_update' | 'updated' | 'already_current' | 'refused'
	refusalReasons: Array<JobAttributionRepairRefusal>
	package: { packageId: string; ownerId: string; sourceId: string }
	source: {
		publishedCommit: string | null
		servingCommit: string | null
		servingArtifactCommit: string | null
	} | null
	job: {
		jobId: string
		name: string
		enabled: boolean
		recordedCommit: string | null
	} | null
	diff: {
		field: 'jobs.published_commit'
		from: string | null
		to: string
	} | null
	/** True when an apply write was rolled back after a pointer race. */
	compensated: boolean
}

type RepairState = {
	source: EntitySourceRow | null
	job: JobRecord | null
}

async function readState(input: {
	env: Env
	ownerId: string
	sourceId: string
	jobId: string
}): Promise<RepairState> {
	const [source, jobRow] = await Promise.all([
		getEntitySourceById(input.env.APP_DB, input.sourceId),
		jobsData(input.env).getJobById({
			userId: input.ownerId,
			jobId: input.jobId,
		}),
	])
	return {
		source: source && source.user_id === input.ownerId ? source : null,
		job: jobRow?.record ?? null,
	}
}

/**
 * Pure decision for one state snapshot. `already_current` wins over
 * `recorded_commit_mismatch` so a retried apply is a no-op success.
 */
function evaluate(input: {
	state: RepairState
	sourceId: string
	expectedRecordedCommit: string
	expectedServingCommit: string
}): {
	reasons: Array<JobAttributionRepairRefusal>
	alreadyCurrent: boolean
	servingCommit: string | null
} {
	const { source, job } = input.state
	const reasons: Array<JobAttributionRepairRefusal> = []
	if (!source) reasons.push('source_not_found')
	if (!job) reasons.push('job_not_found')
	else if (job.sourceId !== input.sourceId) reasons.push('job_not_in_package')
	const servingCommit = source ? servingCommitForSource(source) : null
	if (source) {
		if (servingCommit == null) reasons.push('serving_commit_unavailable')
		else if (servingCommit !== input.expectedServingCommit) {
			reasons.push('serving_commit_mismatch')
		}
		// A publish that moved published_commit but has not proven its
		// artifacts yet owns the job pins; do not fight it.
		if (
			source.serving_commit != null &&
			source.published_commit !== source.serving_commit
		) {
			reasons.push('publish_in_progress')
		}
	}
	const alreadyCurrent =
		reasons.length === 0 && job != null && job.publishedCommit === servingCommit
	if (
		!alreadyCurrent &&
		job != null &&
		job.publishedCommit !== input.expectedRecordedCommit
	) {
		reasons.push('recorded_commit_mismatch')
	}
	return { reasons, alreadyCurrent, servingCommit }
}

function describe(input: {
	mode: JobAttributionRepairResult['mode']
	outcome: JobAttributionRepairResult['outcome']
	reasons: Array<JobAttributionRepairRefusal>
	pkg: JobAttributionRepairResult['package']
	state: RepairState
	diff: JobAttributionRepairResult['diff']
	compensated?: boolean
}): JobAttributionRepairResult {
	const { source, job } = input.state
	return {
		mode: input.mode,
		outcome: input.outcome,
		refusalReasons: input.reasons,
		package: input.pkg,
		source: source
			? {
					publishedCommit: source.published_commit,
					servingCommit: servingCommitForSource(source),
					servingArtifactCommit: servingArtifactCommitForSource(source),
				}
			: null,
		job: job
			? {
					jobId: job.id,
					name: job.name,
					enabled: job.enabled,
					recordedCommit: job.publishedCommit,
				}
			: null,
		diff: input.diff,
		compensated: input.compensated ?? false,
	}
}

/**
 * Admin repair of one package job's recorded `published_commit` to the
 * package's current serving commit. Dry-run unless `apply`. Writes only that
 * column (plus `updated_at`) through a compare-and-set on the expected old
 * commit; never rebuilds, republishes, runs the job, changes enablement or
 * schedule, or touches the source pointers.
 *
 * Jobs live in a different D1 database from `entity_sources`, so the source
 * guard is a re-read right after the write: if the serving pointer moved in
 * between, the write is compare-and-set back to the expected old commit and
 * the apply is refused.
 */
export async function repairPackageJobAttribution(input: {
	env: Env
	target: PackageProvenanceTarget
	jobId: string
	expectedRecordedCommit: string
	expectedServingCommit: string
	apply: boolean
}): Promise<JobAttributionRepairResult | null> {
	const pkg = await resolvePackageForProvenance(input.env.APP_DB, input.target)
	if (!pkg) return null
	const ownerId = pkg.userId
	const pkgSummary = {
		packageId: pkg.id,
		ownerId,
		sourceId: pkg.sourceId,
	}
	const mode = input.apply ? 'apply' : 'dry_run'
	const read = () =>
		readState({
			env: input.env,
			ownerId,
			sourceId: pkg.sourceId,
			jobId: input.jobId,
		})
	const decide = (state: RepairState) =>
		evaluate({
			state,
			sourceId: pkg.sourceId,
			expectedRecordedCommit: input.expectedRecordedCommit,
			expectedServingCommit: input.expectedServingCommit,
		})
	const state = await read()
	const decision = decide(state)
	if (decision.alreadyCurrent) {
		return describe({
			mode,
			outcome: 'already_current',
			reasons: [],
			pkg: pkgSummary,
			state,
			diff: null,
		})
	}
	if (decision.reasons.length > 0 || decision.servingCommit == null) {
		return describe({
			mode,
			outcome: 'refused',
			reasons: decision.reasons,
			pkg: pkgSummary,
			state,
			diff: null,
		})
	}
	const target = decision.servingCommit
	const diff = {
		field: 'jobs.published_commit' as const,
		from: state.job?.publishedCommit ?? null,
		to: target,
	}
	if (!input.apply) {
		return describe({
			mode,
			outcome: 'would_update',
			reasons: [],
			pkg: pkgSummary,
			state,
			diff,
		})
	}
	const store = jobsData(input.env)
	const wrote = await store.repairPackageJobPublishedCommit({
		userId: ownerId,
		jobId: input.jobId,
		sourceId: pkg.sourceId,
		expectedPublishedCommit: input.expectedRecordedCommit,
		publishedCommit: target,
		updatedAt: new Date().toISOString(),
	})
	const after = await read()
	if (!wrote) {
		const retry = decide(after)
		if (retry.alreadyCurrent) {
			return describe({
				mode,
				outcome: 'already_current',
				reasons: [],
				pkg: pkgSummary,
				state: after,
				diff: null,
			})
		}
		return describe({
			mode,
			outcome: 'refused',
			reasons: ['write_conflict', ...retry.reasons],
			pkg: pkgSummary,
			state: after,
			diff: null,
		})
	}
	const afterServing = after.source
		? servingCommitForSource(after.source)
		: null
	const pointerStable =
		afterServing === target &&
		after.source != null &&
		(after.source.serving_commit == null ||
			after.source.published_commit === after.source.serving_commit)
	if (!pointerStable) {
		const compensated = await store.repairPackageJobPublishedCommit({
			userId: ownerId,
			jobId: input.jobId,
			sourceId: pkg.sourceId,
			expectedPublishedCommit: target,
			publishedCommit: input.expectedRecordedCommit,
			updatedAt: new Date().toISOString(),
		})
		return describe({
			mode,
			outcome: 'refused',
			reasons: ['source_changed_during_apply'],
			pkg: pkgSummary,
			state: await read(),
			diff: null,
			compensated,
		})
	}
	return describe({
		mode,
		outcome: 'updated',
		reasons: [],
		pkg: pkgSummary,
		state: after,
		diff,
	})
}
