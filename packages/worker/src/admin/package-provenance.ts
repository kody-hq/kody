import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { getPackageNameScope } from '#worker/package-registry/package-name.ts'
import {
	getSavedPackageByIdInAnyOrg,
	resolveSavedPackageRef,
} from '#worker/package-registry/repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	checkSourceRepoCommitAncestry,
	type CommitAncestryResult,
} from '#worker/repo/commit-ancestry.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { listPublishedBundleArtifactsBySourceId } from '#worker/repo/published-bundle-artifacts-repo.ts'
import {
	servingArtifactCommitForSource,
	servingCommitForSource,
} from '#worker/repo/serving-commit.ts'
import { listWorkflowProjections } from '#worker/run-records/service.ts'

const packageProvenanceRecentRunLimit = 20

/** Durable workflows that publish a package (see `publish-external-push.ts`). */
const publishWorkflowNames = new Set(['packagePublishExternalPush'])

type PackageProvenanceTarget =
	| { packageId: string; packageName?: undefined }
	| { packageName: string; packageId?: undefined }

type PackageProvenancePublishRun = {
	id: string
	kind: 'publish_workflow' | 'publish_build'
	status: string | null
	commit: string | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	errorClass: string | null
}

type PackageProvenance = {
	package: {
		packageId: string
		kodyId: string
		name: string
		ownerId: string
		ownerHandle: string | null
		sourceId: string
	}
	source: {
		publishedCommit: string | null
		servingCommit: string | null
		servingArtifactCommit: string | null
	} | null
	artifacts: Array<{
		kind: string
		name: string | null
		entryPoint: string
		builtFromCommit: string
		updatedAt: string
	}>
	jobs: Array<{
		jobId: string
		name: string
		enabled: boolean
		scheduleType: string
		recordedCommit: string | null
		runsCommit: string | null
		lastRunAt: string | null
		lastRunStatus: string | null
		lastRunErrorClass: string | null
		nextRunAt: string
	}>
	triggers: Array<{
		kind: string
		name: string
		state: string
		pinnedCommit: null
		runsCommit: string | null
		updatedAt: string
	}>
	webhooks: Array<{
		endpointId: string
		name: string
		pinnedCommit: null
		runsCommit: string | null
		createdAt: string
	}>
	publishRuns: Array<PackageProvenancePublishRun>
	publishRunsComplete: boolean
	ancestry: CommitAncestryResult | null
}

/**
 * Short, content-free class for a stored error: a leading `SomethingError`
 * name or snake_case code, else `error`. Never the message itself.
 */
function classifyStoredError(text: string | null | undefined): string | null {
	const trimmed = text?.trim()
	if (!trimmed) return null
	const named = /^([A-Z][A-Za-z0-9]{0,62}(?:Error|Exception))\b/.exec(trimmed)
	if (named?.[1]) return named[1]
	const code = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=$|[\s:.,(])/.exec(trimmed)
	if (code?.[1] && code[1].length <= 64) return code[1]
	return 'error'
}

async function resolvePackageForProvenance(
	db: D1Database,
	target: PackageProvenanceTarget,
): Promise<SavedPackageRecord | null> {
	if (target.packageId !== undefined) {
		return await getSavedPackageByIdInAnyOrg(db, target.packageId.trim())
	}
	const scope = getPackageNameScope(target.packageName)
	if (!scope) return null
	const owner = await findPublicOwnerIdentityByHandle({ db, handle: scope })
	if (!owner) return null
	return await resolveSavedPackageRef(db, {
		userId: owner.ownerId,
		ref: target.packageName,
	})
}

async function loadOwnerHandle(db: D1Database, ownerId: string) {
	const row = await db
		.prepare(`SELECT slug FROM orgs WHERE id = ?`)
		.bind(ownerId)
		.first<{ slug: string | null }>()
	return row?.slug ?? null
}

async function loadTriggers(db: D1Database, packageId: string) {
	const result = await db
		.prepare(
			`SELECT trigger_kind, trigger_name, state, updated_at
			FROM enablements
			WHERE package_id = ?
			ORDER BY trigger_kind, trigger_name, updated_at DESC`,
		)
		.bind(packageId)
		.all<{
			trigger_kind: string
			trigger_name: string
			state: string
			updated_at: string
		}>()
	return result.results ?? []
}

async function loadWebhookEndpoints(
	db: D1Database,
	input: { ownerId: string; packageId: string },
) {
	const result = await db
		.prepare(
			`SELECT id, webhook_name, created_at
			FROM webhook_endpoints
			WHERE user_id = ? AND package_id = ? AND deleted_at IS NULL
			ORDER BY webhook_name, created_at`,
		)
		.bind(input.ownerId, input.packageId)
		.all<{
			id: string
			webhook_name: string
			created_at: string
		}>()
	return result.results ?? []
}

async function loadPublishBuildRuns(
	db: D1Database,
	packageId: string,
): Promise<Array<PackageProvenancePublishRun>> {
	const result = await db
		.prepare(
			`SELECT id, status, commit_sha, message, created_at, updated_at, committed_at
			FROM publish_builds
			WHERE package_id = ?
			ORDER BY created_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(packageId, packageProvenanceRecentRunLimit)
		.all<{
			id: string
			status: string
			commit_sha: string
			message: string | null
			created_at: string
			updated_at: string
			committed_at: string | null
		}>()
	return (result.results ?? []).map((row) => ({
		id: row.id,
		kind: 'publish_build',
		status: row.status,
		commit: row.commit_sha,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.committed_at,
		errorClass:
			row.status === 'rejected' ? classifyStoredError(row.message) : null,
	}))
}

async function loadPublishWorkflowRuns(input: {
	env: Env
	ownerId: OwnerId
	packageId: string
}): Promise<Array<PackageProvenancePublishRun> | null> {
	try {
		const { projections } = await listWorkflowProjections({
			env: input.env,
			userId: input.ownerId,
			packageId: input.packageId,
			limit: packageProvenanceRecentRunLimit,
		})
		return projections
			.filter((projection) => publishWorkflowNames.has(projection.workflowName))
			.map((projection) => ({
				id: projection.id,
				kind: 'publish_workflow',
				status: projection.status,
				commit: projection.enqueuedCommit,
				createdAt: projection.createdAt,
				updatedAt: projection.updatedAt,
				completedAt: projection.completedAt,
				errorClass: classifyStoredError(projection.lastError),
			}))
	} catch {
		return null
	}
}

/**
 * Read-only provenance for one package of any owner: SHAs and metadata only.
 * Never reads file contents, artifact payloads, secrets, or run logs.
 */
export async function loadPackageProvenance(input: {
	env: Env
	target: PackageProvenanceTarget
	ancestry?: { ancestor: string; descendant: string } | null
}): Promise<PackageProvenance | null> {
	const db = input.env.APP_DB
	const pkg = await resolvePackageForProvenance(db, input.target)
	if (!pkg) return null
	const ownerId = pkg.userId
	const [ownerHandle, source, artifacts, jobRows, triggers, webhooks] =
		await Promise.all([
			loadOwnerHandle(db, ownerId),
			getEntitySourceById(db, pkg.sourceId),
			listPublishedBundleArtifactsBySourceId(db, ownerId, pkg.sourceId),
			jobsData(input.env).listJobsForUser({ userId: ownerId }),
			loadTriggers(db, pkg.id),
			loadWebhookEndpoints(db, { ownerId, packageId: pkg.id }),
		])
	const servingCommit = source ? servingCommitForSource(source) : null
	const [buildRuns, workflowRuns, ancestry] = await Promise.all([
		loadPublishBuildRuns(db, pkg.id),
		loadPublishWorkflowRuns({ env: input.env, ownerId, packageId: pkg.id }),
		input.ancestry && source
			? checkSourceRepoCommitAncestry({
					env: input.env,
					repoId: source.repo_id,
					ancestor: input.ancestry.ancestor,
					descendant: input.ancestry.descendant,
				})
			: null,
	])
	const publishRuns = [...(workflowRuns ?? []), ...buildRuns]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
		.slice(0, packageProvenanceRecentRunLimit)
	return {
		package: {
			packageId: pkg.id,
			kodyId: pkg.kodyId,
			name: pkg.name,
			ownerId,
			ownerHandle,
			sourceId: pkg.sourceId,
		},
		source: source
			? {
					publishedCommit: source.published_commit,
					servingCommit,
					servingArtifactCommit: servingArtifactCommitForSource(source),
				}
			: null,
		artifacts: artifacts.map((artifact) => ({
			kind: artifact.artifactKind,
			name: artifact.artifactName,
			entryPoint: artifact.entryPoint,
			builtFromCommit: artifact.publishedCommit,
			updatedAt: artifact.updatedAt,
		})),
		jobs: jobRows
			.filter((row) => row.record.sourceId === pkg.sourceId)
			.map(({ record }) => ({
				jobId: record.id,
				name: record.name,
				enabled: record.enabled,
				scheduleType: record.schedule.type,
				recordedCommit: record.publishedCommit,
				runsCommit: servingCommit,
				lastRunAt: record.lastRunAt ?? null,
				lastRunStatus: record.lastRunStatus ?? null,
				lastRunErrorClass: classifyStoredError(record.lastRunError),
				nextRunAt: record.nextRunAt,
			})),
		triggers: triggers.map((row) => ({
			kind: row.trigger_kind,
			name: row.trigger_name,
			state: row.state,
			pinnedCommit: null,
			runsCommit: servingCommit,
			updatedAt: row.updated_at,
		})),
		webhooks: webhooks.map((row) => ({
			endpointId: row.id,
			name: row.webhook_name,
			pinnedCommit: null,
			runsCommit: servingCommit,
			createdAt: row.created_at,
		})),
		publishRuns,
		publishRunsComplete: workflowRuns !== null,
		ancestry,
	}
}
