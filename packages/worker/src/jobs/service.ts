import {
	type OwnerId,
	type PersonId,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type ExecuteResult } from '@cloudflare/codemode'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	backgroundRunBilledActor,
	parseRequestLineage,
	type RequestOrgBinding,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import { buildNoEnablementSkipError } from '#worker/enablements/enablement-agent-hints.ts'
import { ensureOwnerCronEnablementForJob } from '#worker/enablements/owner-cron-enablement.ts'
import {
	planEnablementRuns,
	type EnablementSkip,
} from '#worker/enablements/run-gate.ts'
import {
	createMcpCallerContext,
	createMcpCallerContextWire,
	parseMcpCallerContextWire,
} from '#mcp/context.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { deleteJobVector, upsertJobVector } from '#mcp/jobs-vectorize.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import {
	abandonRunRecord,
	claimRunRecord,
	finishRunRecord,
	getJobRunObservability,
	getRunRecord,
	upsertJobRunObservability,
} from '#worker/run-records/service.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { hydrateJobViewFromRunLog } from './job-run-observability-hydrate.ts'
import { applyExecutionOutcome, processDueJobs } from './process-due-jobs.ts'
import { syncJobManagerAlarm } from './manager-client.ts'
import { type JobRow } from '@kody-internal/shared/jobs/repo.ts'
import { jobsData } from './jobs-data.ts'
import {
	buildScheduledJobIdempotencyKey,
	computeJobRetryAt,
	executeOrReplayScheduledJobRun,
	isTransientJobExecutionError,
	markPreExecutionTransientError,
	resolveScheduledJobCallerContext,
	TransientJobExecutionError,
} from './execution-safety.ts'
import {
	computeNextRunAt,
	estimateScheduleMinIntervalMs,
	formatJobError,
	isJobExpired,
	normalizeJobExpiresAt,
	normalizeJobSchedule,
	normalizeJobTimezone,
	toJobView,
} from './schedule.ts'
import {
	type JobExecutionOutcome,
	type JobExecutionResult,
	type JobRepoCheckPolicy,
	type JobRecord,
	type JobSchedule,
	type JobUpdateInput,
	type PersistedJobCallerContext,
} from './types.ts'
import { createJobStorageId } from '#worker/storage-runner.ts'
import { stampFirstJob } from '#worker/identity/activation-stamps.ts'
import {
	isBudgetLimitError,
	isComputeOverageLimitError,
	isEntitlementLimitError,
	JobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { orgBudgetForJobExecution } from '#worker/entitlements/budget-gate.ts'
import {
	assertWithinEntitlement,
	consumeDailyEntitlement,
	getCachedUserEntitlement,
} from '#worker/entitlements/service.ts'
import {
	getOrgById,
	loadOrgBindingForOrg,
	type OrgRecord,
} from '#worker/orgs/repo.ts'
import {
	resolvePlanLimits,
	type CreditWalletState,
	type EntitlementLadder,
	type PlanName,
} from '#universal/plans.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { isAccountSuspendedError } from '#worker/account/account-suspension.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from '#worker/package-runtime/published-source-dependencies.ts'
import {
	normalizePackageWorkspacePath,
	type parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	getEntitySourceById,
	getEntitySourceByIdForUser,
} from '#worker/repo/entity-sources.ts'
import {
	isPublishedBundleArtifactCurrentForCommit,
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { resolvePublishedJobSource } from './inspect-published-source.ts'
import {
	getJob,
	getJobInspection,
	inspectJobsForUser,
	listJobs,
} from './inspect.ts'
import {
	type PublishedBundleArtifact,
	bundleArtifactVersion,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	logJobSchedulerEvent,
	type SchedulerJobOutcomeLog,
} from './scheduler-logging.ts'
import {
	buildPackageJobId,
	requirePackageIdFromJobId,
} from './package-job-id.ts'

export { getJob, getJobInspection, inspectJobsForUser, listJobs }

function requirePersistableJobCallerContext(
	callerContext: McpCallerContext,
): PersistedJobCallerContext {
	const { orgBinding: _derivedAtRequestTime, ...wire } =
		parseMcpCallerContextWire(callerContext)
	if (!wire.user) {
		throw new Error('Authenticated MCP user is required for job operations.')
	}
	return { ...wire, user: wire.user }
}

/**
 * The clicker's request reaches run-now through the jobs worker RPC, so its
 * lineage is re-validated, not trusted. Run now runs as the clicker, so a
 * request with no person behind it runs nothing.
 */
function runNowRequestSource(
	callerContext: McpCallerContext | null | undefined,
	jobId: string,
): RequestSource {
	const lineage = callerContext
		? parseRequestLineage(callerContext.request)
		: null
	if (!lineage?.actor) {
		throw new McpCallerError(
			`Job "${jobId}" can only be run now by a signed-in person, who it then runs as.`,
		)
	}
	return { kind: 'inherited', lineage }
}

export function serializeCallerContext(
	callerContext: PersistedJobCallerContext,
) {
	return JSON.stringify(callerContext)
}

function normalizeOptionalParams(
	params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	return params === null || params === undefined ? undefined : params
}

async function buildPublishedJobBundle(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	sourceFiles: Record<string, string>
	entryPoint: string
	rootPackageId?: string | null
}) {
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: input.sourceFiles,
		bundleLabel: `Saved package job "${normalizePackageWorkspacePath(
			input.entryPoint,
		)}"`,
	})
	// Load the worker bundler lazily so registry-only/node test paths that import
	// jobs/service.ts do not eagerly pull the heavy bundler stack.
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
	return await buildKodyModuleBundle(input)
}

async function persistPublishedJobBundleArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	sourceId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	artifactName?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId: string
	} | null
}) {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source?.published_commit) {
		return null
	}
	logJobSchedulerEvent({
		event: 'job_bundle_build_started',
		userId: input.job.userId,
		jobId: input.job.id,
		sourceId: input.sourceId,
		artifactEntryPoint: input.entryPoint,
		reason: 'bundle_missing_or_stale',
	})
	const bundle = await buildPublishedJobBundle({
		env: input.env,
		baseUrl: input.callerContext.baseUrl,
		userId: input.job.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.packageContext?.packageId ?? null,
	})
	const artifact: PublishedBundleArtifact = {
		version: bundleArtifactVersion,
		kind: 'job',
		artifactName: input.artifactName ?? null,
		sourceId: input.sourceId,
		publishedCommit: source.published_commit,
		entryPoint: input.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		dynamicDependencies: bundle.dynamicDependencies ?? [],
		packageContext: input.packageContext ?? null,
		createdAt: new Date().toISOString(),
	}
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.job.userId,
		source,
		kind: 'job',
		artifactName: input.artifactName,
		entryPoint: input.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		dynamicDependencies: bundle.dynamicDependencies,
		packageContext: input.packageContext ?? null,
	})
	logJobSchedulerEvent({
		event: 'job_bundle_build_completed',
		userId: input.job.userId,
		jobId: input.job.id,
		sourceId: input.sourceId,
		artifactEntryPoint: input.entryPoint,
		artifactCacheHit: false,
		dependencyCount: bundle.dependencies.length,
	})
	return artifact
}

function isPublishedJobBundleCurrent(input: {
	artifact: PublishedBundleArtifact | null
	rowPublishedCommit?: string | null
	currentPublishedCommit: string | null
}) {
	return isPublishedBundleArtifactCurrentForCommit(input)
}

async function ensurePublishedBundleArtifactForJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
}) {
	const resolved = await resolvePublishedJobSource({
		env: input.env,
		userId: input.job.userId,
		job: input.job,
	})
	const artifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.job.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName: resolved.artifactName,
		entryPoint: resolved.entryPoint,
	})
	if (
		artifact?.artifact &&
		isPublishedJobBundleCurrent({
			artifact: artifact.artifact,
			rowPublishedCommit: artifact.row?.publishedCommit,
			currentPublishedCommit: resolved.source.published_commit,
		})
	) {
		logJobSchedulerEvent({
			event: 'job_bundle_cache_hit',
			userId: input.job.userId,
			jobId: input.job.id,
			sourceId: input.job.sourceId,
			artifactEntryPoint: artifact.row?.entryPoint ?? 'unknown',
			artifactCacheHit: true,
			dependencyCount: artifact.artifact.dependencies.length,
		})
		return artifact.artifact
	}
	logJobSchedulerEvent({
		event: 'job_bundle_cache_miss',
		userId: input.job.userId,
		jobId: input.job.id,
		sourceId: input.job.sourceId,
		artifactCacheHit: false,
		reason: 'bundle_not_found',
	})
	const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: resolved.files,
		entryPoints: [
			{
				path: resolved.entryPoint,
			},
		],
		emittedEventTopics: resolved.emittedEventTopics,
	})
	if (!typecheckResult.ok) {
		throw new Error(typecheckResult.message)
	}
	await persistPublishedJobBundleArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceId: input.job.sourceId,
		sourceFiles: resolved.files,
		entryPoint: resolved.entryPoint,
		artifactName: resolved.artifactName,
		packageContext: resolved.packageContext,
	})
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.job.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName: resolved.artifactName,
		entryPoint: resolved.entryPoint,
	})
	if (!loadedArtifact?.artifact) {
		throw new Error(
			`Published bundle artifact for job "${input.job.id}" could not be loaded after rebuild.`,
		)
	}
	return loadedArtifact.artifact
}

async function rebuildAndExecuteJobArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	source: RequestSource
	sourceFiles: Record<string, string>
	entryPoint: string
	artifactName?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId: string
	} | null
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}) {
	if (!input.job.sourceId) {
		throw new Error('Repo-backed job source is missing.')
	}
	const artifact = await persistPublishedJobBundleArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceId: input.job.sourceId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		artifactName: input.artifactName,
		packageContext: input.packageContext ?? null,
	}).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	if (!artifact) {
		throw new Error(
			`Published bundle artifact for job "${input.job.id}" could not be persisted.`,
		)
	}
	return await executePublishedJobArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		source: input.source,
		artifact,
		bypassLogs: [],
		waitUntil: input.waitUntil,
		runRecordHandle: input.runRecordHandle,
		idempotencyKey: input.idempotencyKey,
	})
}

async function executePublishedJobArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	source: RequestSource
	artifact:
		| PublishedBundleArtifact
		| Awaited<ReturnType<typeof ensurePublishedBundleArtifactForJob>>
	bypassLogs: Array<string>
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}): Promise<ExecuteResult> {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.job.sourceId,
	).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	const callerContext = createMcpCallerContext({
		...input.callerContext,
		source: input.source,
		repoContext: source
			? {
					sourceId: source.id,
					repoId: source.repo_id,
					sessionId: null,
					baseCommit: source.published_commit,
					manifestPath: source.manifest_path,
					sourceRoot: source.source_root,
					publishedCommit: source.published_commit,
					entityKind: source.entity_kind,
					entityId: source.entity_id,
				}
			: null,
	})
	const packageContext = input.artifact.packageContext ?? null
	const runRecord = {
		surface: 'job' as const,
		name: input.job.name,
		jobId: input.job.id,
		storageId: input.job.storageId,
		sourceId: packageContext?.sourceId ?? input.job.sourceId,
		publishedCommit: source?.published_commit ?? input.job.publishedCommit,
		...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
		...(packageContext
			? {
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				}
			: {}),
	}
	// Avoid a top-level jobs -> package-invocations cycle during capability
	// registry initialization.
	const { createPackageEventTools } =
		await import('#worker/package-invocations/service.ts')
	const packageRuntimeTools = packageContext
		? {
				packageEventTools: createPackageEventTools({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					callerContext,
					parentRunRecord: runRecord,
					packageInvokeDepth: 0,
					waitUntil: input.waitUntil,
					packageContext,
				}),
			}
		: {}
	return await runBundledModuleWithRegistry(
		input.env,
		callerContext,
		{
			mainModule: input.artifact.mainModule,
			modules: input.artifact.modules,
			dependencies: input.artifact.dependencies,
		},
		input.job.params,
		{
			...(packageContext ? { packageContext } : {}),
			executorTimeoutMs: backgroundExecutorTimeoutMs,
			runRecord,
			runRecordHandle: input.runRecordHandle,
			...packageRuntimeTools,
			// Keep waitUntil even when the caller pre-claimed the run record
			// (scheduled jobs). Terminal run-record writes stay awaited inside
			// finishRunRecord; waitUntil only owns deferred work such as
			// static-call meter finalization so a slow D1 rollup path cannot
			// lose events to the no-waitUntil two-second race.
			waitUntil: input.waitUntil,
		},
	).then((result) => ({
		...result,
		logs: [...input.bypassLogs, ...(result.logs ?? [])],
	}))
}

export async function createPackageJobCallerContext(input: {
	env: Env
	db: D1Database
	baseUrl: string
	/** Package storage OwnerId (person or team org). */
	userId: OwnerId
	packageId: string
}): Promise<PersistedJobCallerContext> {
	const user = await resolveBackgroundMcpUser(input.db, input.userId)
	const wire = createMcpCallerContextWire({
		baseUrl: input.baseUrl,
		executionOrigin: 'background',
		user,
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			packageId: input.packageId,
			storageId: null,
		},
		repoContext: null,
	})
	return { ...wire, user }
}

class JobOrgAccessError extends Error {
	override readonly name = 'JobOrgAccessError'
}

/**
 * The org binding a run executes under, resolved from APP_DB at run time.
 * The persisted blob's binding (and role) is never authoritative: the job's
 * org must be live, and a run-now actor or enabler must still hold access to
 * it. Legacy schedule runs carry no actor, so their binding has no role,
 * exactly as a fresh schedule tick derives it.
 */
async function resolveJobRunOrgBinding(input: {
	db: D1Database
	job: JobRecord
	org: OrgRecord | null
	source: RequestSource
}): Promise<RequestOrgBinding> {
	if (!input.org) {
		throw new JobOrgAccessError(
			`Job "${input.job.id}" belongs to an organization that is no longer active.`,
		)
	}
	const org = { id: ownerIdFromStored(input.org.id), slug: input.org.slug }
	const actor = backgroundRunBilledActor(input.source)
	if (!actor) return { org, role: null }
	const binding = await loadOrgBindingForOrg(input.db, actor.userId, org.id)
	if (!binding) {
		throw new JobOrgAccessError(
			`Job "${input.job.id}" cannot run: ${input.source.kind === 'inherited' ? 'the requesting person' : 'its enabler'} no longer has access to its organization.`,
		)
	}
	return binding
}

async function resolveJobRuntimeCallerContext(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	backgroundUser: NonNullable<PersistedJobCallerContext['user']>
	orgBinding: RequestOrgBinding
}): Promise<PersistedJobCallerContext & { orgBinding: RequestOrgBinding }> {
	return {
		...input.callerContext,
		executionOrigin: 'background',
		user: input.backgroundUser,
		orgBinding: input.orgBinding,
		storageContext: {
			sessionId: input.callerContext.storageContext?.sessionId ?? null,
			appId: input.callerContext.storageContext?.appId ?? null,
			packageId: input.callerContext.storageContext?.packageId ?? null,
			storageId: input.job.storageId,
		},
		repoContext: input.callerContext.repoContext ?? null,
	}
}

export async function syncPackageJobsForPackage(input: {
	env: Env
	userId: OwnerId
	baseUrl: string
	packageId: string
	sourceId: string
	manifest: Awaited<ReturnType<typeof parseAuthoredPackageJson>>
	/** Publishing person when known; preferred enabler over earliest Owner. */
	actorUserId?: PersonId
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		async write() {
			const desiredJobs = input.manifest.kody.jobs ?? {}
			const existingRows = await jobsData(input.env).listJobsForUser({
				userId: input.userId,
			})
			const packageRows = existingRows.filter(
				(row) => row.source_id === input.sourceId,
			)
			// Nothing to create, update, or remove: skip the owner lookup.
			if (Object.keys(desiredJobs).length === 0 && packageRows.length === 0) {
				return false
			}
			const [callerContext, source] = await Promise.all([
				createPackageJobCallerContext({
					env: input.env,
					db: input.env.APP_DB,
					baseUrl: input.baseUrl,
					userId: input.userId,
					packageId: input.packageId,
				}),
				getEntitySourceByIdForUser(input.env.APP_DB, {
					id: input.sourceId,
					userId: input.userId,
				}),
			])
			const callerContextJson = serializeCallerContext(callerContext)
			const publishedCommit = source?.published_commit ?? null
			const existingByName = new Map(
				packageRows.map((row) => [row.name, row] as const),
			)
			const desiredNames = new Set(Object.keys(desiredJobs))
			const jobsToCreate = [...desiredNames].filter(
				(name) => !existingByName.has(name),
			).length
			const jobsToRemove = packageRows.filter(
				(row) => !desiredNames.has(row.name),
			).length
			if (jobsToCreate > 0) {
				await assertWithinEntitlement({
					db: input.env.APP_DB,
					userId: input.userId,
					email: callerContext.user.email,
					resource: 'scheduled_jobs',
					requested: jobsToCreate,
					getCurrent: async () =>
						Math.max(
							0,
							(await jobsData(input.env).countJobsForUser({
								userId: input.userId,
							})) - jobsToRemove,
						),
				})
			}
			const entitlement = await getCachedUserEntitlement(input.env.APP_DB, {
				userId: input.userId,
				email: callerContext.user.email,
			})
			const plan = entitlement.plan
			for (const [jobName, definition] of Object.entries(desiredJobs)) {
				const existing = existingByName.get(jobName)
				const schedule = normalizeJobSchedule(definition.schedule)
				const timezone = normalizeJobTimezone(definition.timezone)
				if (
					packageJobNeedsIntervalFloor({
						existingSchedule: existing?.record.schedule,
						existingTimezone: existing?.record.timezone,
						schedule,
						timezone,
					})
				) {
					assertJobScheduleIntervalFloor({
						plan,
						ladder: entitlement.ladder,
						creditWallet: entitlement.creditWallet,
						schedule,
						timezone,
					})
				}
			}
			const now = new Date().toISOString()
			let schedulerStateChanged = false
			const ensureOwnerEnablement = async (job: {
				id: string
				name: string
				enabled: boolean
				isCreate: boolean
			}) => {
				// Create (including disabled): insert owner cron enablement so a
				// later job enable runs without a separate enablementEnable.
				// Existing rows: only repair enablements for jobs that are still
				// enabled. Never insert/reactivate enablements for a disabled
				// job on republish — that re-fired Kent's morning-briefing
				// crons after stamp migration (#3836).
				if (!job.isCreate && !job.enabled) return
				await ensureOwnerCronEnablementForJob({
					db: input.env.APP_DB,
					orgId: input.userId,
					jobId: job.id,
					jobName: job.name,
					packageId: input.packageId,
					enablerUserId: input.actorUserId,
					now,
				})
			}

			for (const [jobName, definition] of Object.entries(desiredJobs)) {
				const existing = existingByName.get(jobName)
				const schedule = normalizeJobSchedule(definition.schedule)
				const timezone = normalizeJobTimezone(definition.timezone)
				const enabled = resolvePackageJobEnabled({
					existingEnabled: existing?.record.enabled,
					manifestEnabled: definition.enabled,
				})
				if (existing) {
					const schedulerStateMatches =
						JSON.stringify(existing.record.schedule) ===
							JSON.stringify(schedule) &&
						existing.record.timezone === timezone &&
						existing.record.enabled === enabled
					if (schedulerStateMatches) {
						const refreshed = await jobsData(
							input.env,
						).refreshPackageJobIdentity({
							userId: input.userId,
							jobId: existing.record.id,
							sourceId: input.sourceId,
							publishedCommit,
							callerContextJson,
							updatedAt: now,
						})
						if (!refreshed) {
							throw new Error(
								`Package job "${existing.record.id}" identity could not be refreshed.`,
							)
						}
						await ensureOwnerEnablement({
							id: existing.record.id,
							name: jobName,
							enabled,
							isCreate: false,
						})
						continue
					}
					if (
						JSON.stringify(existing.record.schedule) !==
							JSON.stringify(schedule) ||
						existing.record.timezone !== timezone
					) {
						assertJobScheduleIntervalFloor({
							plan,
							ladder: entitlement.ladder,
							creditWallet: entitlement.creditWallet,
							schedule,
							timezone,
						})
					}
					const updated: JobRecord = {
						...existing.record,
						name: jobName,
						sourceId: input.sourceId,
						publishedCommit,
						schedule,
						timezone,
						enabled,
						updatedAt: now,
						nextRunAt: computeNextRunAt({
							schedule,
							timezone,
						}),
					}
					await jobsData(input.env).updateJob({
						userId: input.userId,
						job: updated,
						callerContextJson,
					})
					await ensureOwnerEnablement({
						id: updated.id,
						name: jobName,
						enabled,
						isCreate: false,
					})
					schedulerStateChanged = true
					continue
				}

				assertJobScheduleIntervalFloor({
					plan,
					ladder: entitlement.ladder,
					creditWallet: entitlement.creditWallet,
					schedule,
					timezone,
				})
				const created: JobRecord = {
					version: 1,
					id: buildPackageJobId(input.packageId, jobName),
					userId: input.userId,
					name: jobName,
					sourceId: input.sourceId,
					publishedCommit,
					storageId: createJobStorageId(
						buildPackageJobId(input.packageId, jobName),
					),
					schedule,
					timezone,
					enabled,
					killSwitchEnabled: false,
					expiresAt: null,
					createdAt: now,
					updatedAt: now,
					nextRunAt: computeNextRunAt({
						schedule,
						timezone,
					}),
					runCount: 0,
					successCount: 0,
					errorCount: 0,
				}
				await jobsData(input.env).insertJob({
					userId: input.userId,
					job: created,
					callerContextJson,
				})
				// New jobs auto-enable for the creator/owner so the schedule runs
				// without a separate ask-the-user enablementEnable step. Other
				// package triggers still never auto-enable on publish.
				await ensureOwnerEnablement({
					id: created.id,
					name: jobName,
					enabled,
					isCreate: true,
				})
				await stampFirstJob(
					input.env.APP_DB,
					{ stableUserId: input.userId, at: now },
					input.env,
				)
				schedulerStateChanged = true
			}

			for (const row of packageRows) {
				if (desiredNames.has(row.name)) continue
				await jobsData(input.env).deleteJob({
					userId: input.userId,
					jobId: row.id,
				})
				await deleteJobVector(input.env, row.id)
				schedulerStateChanged = true
			}
			return schedulerStateChanged
		},
	})
}

function packageJobNeedsIntervalFloor(input: {
	existingSchedule?: JobSchedule
	existingTimezone?: string | null
	schedule: JobSchedule
	timezone?: string | null
}) {
	if (input.existingSchedule === undefined) return true
	return (
		JSON.stringify(input.existingSchedule) !== JSON.stringify(input.schedule) ||
		input.existingTimezone !== input.timezone
	)
}

function assertJobScheduleIntervalFloor(input: {
	plan: PlanName
	ladder?: EntitlementLadder
	creditWallet?: CreditWalletState
	schedule: JobSchedule
	timezone?: string | null
}) {
	const minIntervalMs = resolvePlanLimits(
		input.plan,
		input.ladder ?? 'public',
		input.creditWallet ?? 'none',
	).minJobIntervalMs
	if (minIntervalMs <= 0) return
	const intervalMs = estimateScheduleMinIntervalMs({
		schedule: input.schedule,
		timezone: input.timezone,
	})
	if (intervalMs == null || intervalMs >= minIntervalMs) return
	throw new JobIntervalFloorError({
		plan: input.plan,
		minIntervalMs,
	})
}

function resolvePackageJobEnabled(input: {
	existingEnabled?: boolean
	manifestEnabled?: boolean
}) {
	const manifestEnabled = input.manifestEnabled ?? true
	if (input.existingEnabled === undefined) return manifestEnabled
	// Manifest `enabled` is create-time only. Once a job row exists, keep its
	// runtime enabled flag on republish (codemod / stamp migration / ordinary
	// publish). OR-ing with the manifest used to re-enable jobs Kent had
	// turned off and then insert owner cron enablements for them (#3836).
	// Use jobUpdate / enablementEnable (or a package pause-resume export) to
	// change enabled state after create.
	return input.existingEnabled
}

export async function updateJob(input: {
	env: Env
	callerContext: McpCallerContext
	body: JobUpdateInput
}) {
	const callerContext = requirePersistableJobCallerContext(input.callerContext)
	// The job lives under the org the request is bound to (a team org for a
	// team member), not under the caller's personal org.
	const ownerId = ownerIdFromCaller(input.callerContext)
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: ownerId,
		env: input.env,
		async write() {
			const existingRow = await jobsData(input.env).getJobById({
				userId: ownerId,
				jobId: input.body.id,
			})
			if (!existingRow) {
				throw new McpCallerError(`Job "${input.body.id}" was not found.`)
			}
			const existing = existingRow.record
			requirePackageIdFromJobId(existing.id)
			const nextSchedule =
				input.body.schedule !== undefined
					? normalizeJobSchedule(input.body.schedule)
					: existing.schedule
			const nextTimezone =
				input.body.timezone === null
					? normalizeJobTimezone(null)
					: normalizeJobTimezone(input.body.timezone ?? existing.timezone)
			const nextExpiresAt =
				input.body.expiresAt === undefined
					? (existing.expiresAt ?? null)
					: normalizeJobExpiresAt(input.body.expiresAt)
			const now = new Date()
			const nowIso = now.toISOString()
			const expired = isJobExpired({ expiresAt: nextExpiresAt }, now)
			const nextEnabled = expired
				? false
				: (input.body.enabled ?? existing.enabled)
			const scheduleChanged =
				JSON.stringify(nextSchedule) !== JSON.stringify(existing.schedule)
			const timezoneChanged = nextTimezone !== existing.timezone
			if (scheduleChanged || timezoneChanged) {
				assertJobScheduleIntervalFloor({
					...(await getCachedUserEntitlement(input.env.APP_DB, {
						userId: callerContext.user.userId,
						email: callerContext.user.email,
					})),
					schedule: nextSchedule,
					timezone: nextTimezone,
				})
			}
			const shouldRecomputeNextRunAt =
				scheduleChanged ||
				nextTimezone !== existing.timezone ||
				(existing.enabled === false && nextEnabled === true)
			const updated: JobRecord = {
				...existing,
				params:
					input.body.params === undefined
						? existing.params
						: normalizeOptionalParams(input.body.params),
				schedule: nextSchedule,
				timezone: nextTimezone,
				enabled: nextEnabled,
				killSwitchEnabled:
					input.body.killSwitchEnabled ?? existing.killSwitchEnabled,
				expiresAt: nextExpiresAt,
				updatedAt: nowIso,
				nextRunAt: shouldRecomputeNextRunAt
					? computeNextRunAt({
							schedule: nextSchedule,
							timezone: nextTimezone,
						})
					: existing.nextRunAt,
			}
			const nextCallerContextJson = serializeCallerContext(callerContext)
			const didUpdate = await jobsData(input.env).updateJob({
				userId: ownerId,
				job: updated,
				callerContextJson: nextCallerContextJson,
			})
			if (!didUpdate) {
				throw new Error(`Job "${updated.id}" could not be updated.`)
			}
			if (updated.enabled) {
				await ensureOwnerCronEnablementForJob({
					db: input.env.APP_DB,
					orgId: ownerId,
					jobId: updated.id,
					jobName: updated.name,
					enablerUserId: callerContext.user.userId,
					now: nowIso,
				})
			}
			await upsertJobVector(input.env, {
				jobId: updated.id,
				userId: ownerId,
				embedText: buildJobEmbedText({
					name: updated.name,
					scheduleSummary: toJobView(updated).scheduleSummary,
					sourceId: updated.sourceId,
					publishedCommit: updated.publishedCommit,
				}),
			})
			await syncJobManagerAlarm({
				env: input.env,
				userId: ownerId,
			})
			return toJobView(updated)
		},
	})
}

export async function executeJobOnce(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext | null
	/** A schedule tick, or the person who pressed "run now". */
	source: RequestSource
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}): Promise<JobExecutionOutcome> {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.job.userId,
		env: input.env,
		async write() {
			const started = new Date()
			let execution: JobExecutionResult
			let outcome: 'success' | 'error' = 'success'
			let finished = started
			let durationMs = 0
			let completedOccurrence = false
			try {
				if (!input.callerContext) {
					outcome = 'error'
					execution = {
						ok: false,
						error:
							'Job caller context is missing. Re-save the job to refresh its execution context.',
						logs: [],
					}
					completedOccurrence = true
				} else {
					const backgroundUser = await resolveBackgroundMcpUser(
						input.env.APP_DB,
						input.job.userId,
					).catch((error: unknown) => {
						throw markPreExecutionTransientError(error)
					})
					const orgRecord = await getOrgById(
						input.env.APP_DB,
						input.job.userId,
					).catch((error: unknown) => {
						throw markPreExecutionTransientError(error)
					})
					const orgBinding = await resolveJobRunOrgBinding({
						db: input.env.APP_DB,
						job: input.job,
						org: orgRecord,
						source: input.source,
					})
					const runtimeCallerContext = await resolveJobRuntimeCallerContext({
						env: input.env,
						job: input.job,
						callerContext: input.callerContext,
						backgroundUser,
						orgBinding,
					})
					const orgSlug =
						orgRecord?.slug?.trim() || backgroundUser.username?.trim() || null
					// Daily job-run quota before sandbox work so over-limit
					// ticks cost nothing. Failed attempts still count.
					await consumeDailyEntitlement({
						db: input.env.APP_DB,
						env: input.env,
						userId: input.job.userId,
						email: backgroundUser.email,
						resource: 'job_runs_per_day',
						orgBudget: orgBudgetForJobExecution({
							orgId: input.job.userId,
							orgSlug,
							source: input.source,
						}),
					})
					const result = await runRepoBackedJob({
						env: input.env,
						job: input.job,
						callerContext: runtimeCallerContext,
						source: input.source,
						repoCheckPolicyOverride: input.repoCheckPolicyOverride,
						waitUntil: input.waitUntil,
						runRecordHandle: input.runRecordHandle,
						idempotencyKey: input.idempotencyKey,
					})
					if (result.error) {
						const errorMessage =
							typeof result.error === 'string'
								? result.error
								: formatJobError(result.error)
						// Claimed scheduled occurrences already retry
						// TransientJobExecutionError (D1 blips, DO isolate
						// resets including "instance is no longer active",
						// storage-estimate misses). Sandbox paths return those
						// as result.error instead of throwing, so promote them
						// here. Run-now without a claimed handle still
						// surfaces the error immediately.
						if (
							input.runRecordHandle &&
							isTransientJobExecutionError(result.error)
						) {
							throw new TransientJobExecutionError(errorMessage, {
								cause: result.error,
							})
						}
						outcome = 'error'
					}
					execution = result.error
						? {
								ok: false,
								error:
									typeof result.error === 'string'
										? result.error
										: formatJobError(result.error),
								logs: result.logs ?? [],
							}
						: {
								ok: true,
								result: result.result,
								logs: result.logs ?? [],
							}
					completedOccurrence = true
				}
			} catch (error) {
				if (error instanceof TransientJobExecutionError) {
					throw error
				}
				if (input.runRecordHandle && isTransientJobExecutionError(error)) {
					throw new TransientJobExecutionError(formatJobError(error), {
						cause: error,
					})
				}
				outcome = 'error'
				execution = {
					ok: false,
					error: formatJobError(error),
					logs: [],
				}
				// Daily job-run quota denials, account suspension, and org
				// access checks happen before sandbox work. Still return an
				// error outcome so schedules advance, but do not emit job_run
				// usage or else every denied tick inflates rollups.
				if (
					!isEntitlementLimitError(error) &&
					!isComputeOverageLimitError(error) &&
					!isBudgetLimitError(error) &&
					!isAccountSuspendedError(error) &&
					!(error instanceof JobOrgAccessError)
				) {
					completedOccurrence = true
				}
			} finally {
				finished = new Date()
				durationMs = Math.max(0, finished.valueOf() - started.valueOf())
				const userId = input.job.userId
				if (userId && completedOccurrence) {
					const billedActor = backgroundRunBilledActor(input.source)
					await recordUsage(input.env, {
						userId,
						eventType: 'job_run',
						entityId: input.job.id,
						durationMs,
						outcome,
						actorUserId: billedActor?.userId ?? '',
						automationSource: billedActor ? '' : 'schedule',
					})
				}
			}
			return {
				execution,
				startedAt: started.toISOString(),
				finishedAt: finished.toISOString(),
				durationMs,
			}
		},
	})
}

async function runRepoBackedJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	source: RequestSource
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}): Promise<ExecuteResult> {
	const resolved = await resolvePublishedJobSource({
		env: input.env,
		userId: input.job.userId,
		job: input.job,
	}).catch((error: unknown) => {
		if (isTransientJobExecutionError(error)) {
			throw markPreExecutionTransientError(error)
		}
		return {
			error: formatJobError(error),
		}
	})
	if ('error' in resolved) {
		return {
			error: resolved.error,
			result: null,
			logs: [],
		}
	}
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.job.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName: resolved.artifactName,
		entryPoint: resolved.entryPoint,
	}).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	if (
		loadedArtifact?.artifact &&
		isPublishedJobBundleCurrent({
			artifact: loadedArtifact.artifact,
			rowPublishedCommit: loadedArtifact.row?.publishedCommit,
			currentPublishedCommit: resolved.source.published_commit,
		})
	) {
		return await executePublishedJobArtifact({
			env: input.env,
			job: input.job,
			callerContext: input.callerContext,
			source: input.source,
			artifact: loadedArtifact.artifact,
			bypassLogs: [],
			waitUntil: input.waitUntil,
			runRecordHandle: input.runRecordHandle,
			idempotencyKey: input.idempotencyKey,
		})
	}
	return await rebuildAndExecuteJobArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		source: input.source,
		sourceFiles: resolved.files,
		entryPoint: resolved.entryPoint,
		artifactName: resolved.artifactName,
		packageContext: resolved.packageContext,
		waitUntil: input.waitUntil,
		runRecordHandle: input.runRecordHandle,
		idempotencyKey: input.idempotencyKey,
	})
}

export async function runJobNow(input: {
	env: Env
	userId: OwnerId
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		async write() {
			const row = await jobsData(input.env).getJobById({
				userId: input.userId,
				jobId: input.jobId,
			})
			if (!row) {
				throw new McpCallerError(`Job "${input.jobId}" was not found.`)
			}
			if (isJobExpired(row.record)) {
				throw new McpCallerError(
					`Job "${input.jobId}" expired at ${row.record.expiresAt} and cannot be run.`,
				)
			}
			const activeCallerContext = input.callerContext
				? requirePersistableJobCallerContext(input.callerContext)
				: row.callerContext
			const source = runNowRequestSource(input.callerContext, row.record.id)
			const outcome = await executeJobOnce({
				env: input.env,
				job: row.record,
				callerContext: activeCallerContext,
				source,
				repoCheckPolicyOverride: input.repoCheckPolicyOverride,
				waitUntil: input.waitUntil,
			})
			const updated = applyExecutionOutcome(
				row.record,
				outcome,
				row.record.schedule.type === 'once'
					? { enabled: false }
					: {
							nextRunAt: computeNextRunAt({
								schedule: row.record.schedule,
								timezone: row.record.timezone,
								from: outcome.finishedAt,
							}),
						},
			)
			// Successful once jobs are retained for account/platform cleanup
			// rather than deleted immediately.
			const deletedAfterRun = false
			await jobsData(input.env).updateJob({
				userId: input.userId,
				job: updated,
				callerContextJson: activeCallerContext
					? serializeCallerContext(activeCallerContext)
					: row.callerContextJson,
			})
			const job = await hydrateJobViewFromRunLog({
				env: input.env,
				userId: input.userId,
				job: toJobView(updated),
			})
			return {
				job,
				execution: outcome.execution,
				deletedAfterRun,
			}
		},
	})
}

async function resolveScheduledJobRunAttribution(input: {
	env: Env
	job: JobRecord
}) {
	const packageId = requirePackageIdFromJobId(input.job.id)
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.job.sourceId,
		userId: input.job.userId,
	})
	const publishedCommit =
		source?.published_commit ?? input.job.publishedCommit ?? null
	if (source?.entity_kind !== 'package' || source.entity_id !== packageId) {
		return {
			sourceId: input.job.sourceId,
			publishedCommit,
			packageId: null,
			kodyId: null,
		}
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.job.userId,
		packageId,
	})
	return {
		sourceId: source.id,
		publishedCommit,
		packageId,
		kodyId: savedPackage?.kodyId ?? null,
	}
}

/**
 * The runs one scheduled tick starts: once per on enablement, as
 * its enabler, each with its own idempotency key; with none, nothing runs.
 */
async function planScheduledJobRuns(input: {
	env: Env
	job: JobRecord
	idempotencyKey: string
}): Promise<{
	runs: Array<{ source: RequestSource; idempotencyKey: string }>
	skipped: Array<EnablementSkip>
}> {
	const plan = await planEnablementRuns({
		env: input.env,
		orgId: input.job.userId,
		packageId: requirePackageIdFromJobId(input.job.id),
		trigger: { kind: 'cron', instanceId: input.job.id },
	})
	if (plan.runs.length === 0) {
		console.info('job-tick-skipped-no-enablement', {
			orgId: input.job.userId,
			jobId: input.job.id,
			skipped: plan.skipped,
		})
	}
	return {
		runs: plan.runs.map((enablement) => ({
			source: { kind: 'schedule', jobId: input.job.id, enablement },
			idempotencyKey: `${input.idempotencyKey}:enablement:${enablement.id}`,
		})),
		skipped: plan.skipped,
	}
}

function noEnablementSkipError(input: {
	jobId: string
	jobName: string
	skipped: Array<EnablementSkip>
}): string {
	const pausedOnly =
		input.skipped.length > 0 &&
		input.skipped.every((skip) => skip.reason === 'paused')
	return buildNoEnablementSkipError({
		packageId: requirePackageIdFromJobId(input.jobId),
		jobName: input.jobName,
		reason: pausedOnly ? 'paused' : 'missing',
	})
}

async function executeClaimedScheduledJob(input: {
	env: Env
	row: JobRow
	claimToken: string
	scheduledFor: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	outcome: JobExecutionOutcome | null
	skipped: Array<EnablementSkip>
}> {
	const plan = await planScheduledJobRuns({
		env: input.env,
		job: input.row.record,
		idempotencyKey: buildScheduledJobIdempotencyKey({
			jobId: input.row.record.id,
			scheduledFor: input.scheduledFor,
		}),
	}).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	if (plan.runs.length === 0) {
		return { outcome: null, skipped: plan.skipped }
	}
	let selected: JobExecutionOutcome | null = null
	for (const [index, run] of plan.runs.entries()) {
		// Enablement runs share one claim, and several background-budget runs
		// can outlast a single lease. Stop once another runner owns the slot;
		// finalization is fenced on the same token.
		if (index > 0) {
			const renewed = await jobsData(input.env).renewClaimedJob({
				userId: input.row.record.userId,
				jobId: input.row.id,
				claimToken: input.claimToken,
				nowMs: Date.now(),
			})
			if (!renewed) break
		}
		const outcome = await executeClaimedScheduledJobRun({ ...input, ...run })
		if (!selected || selected.execution.ok) selected = outcome
	}
	if (!selected) throw new Error('Expected at least one scheduled job run.')
	return { outcome: selected, skipped: [] }
}

/**
 * Nothing is on for this slot, so no package run is started. Surface the skip
 * on job observability (last_run_error / error_count) so jobGet does not look
 * armed and healthy.
 *
 * Order: renew the claim (fence superseded leases), record observability keyed
 * by the claimed slot, then settle. When RunLog is configured and the upsert
 * fails, retry shortly instead of advancing a recurring slot with a status-only
 * D1 row. Re-entry for the same slot does not increment counters again.
 */
async function deferClaimedJobWithoutEnablement(input: {
	env: Env
	userId: OwnerId
	row: JobRow
	claimToken: string
	now: Date
	skipped: Array<EnablementSkip>
}): Promise<{
	settled: boolean
	nextRunAt: string
	error: string
}> {
	const { row } = input
	const store = jobsData(input.env)
	const scheduledFor = row.claimed_scheduled_for
	const nowIso = input.now.toISOString()
	const slotAt = scheduledFor ?? nowIso
	const error = noEnablementSkipError({
		jobId: row.id,
		jobName: row.record.name,
		skipped: input.skipped,
	})
	const stillHeld = await store.renewClaimedJob({
		userId: input.userId,
		jobId: row.id,
		claimToken: input.claimToken,
		// Use wall clock: input.now is from runDueJobsForUser start and can lag.
		nowMs: Date.now(),
	})
	if (!stillHeld) {
		logJobSchedulerEvent({
			event: 'claim_lost_before_skip_transition',
			userId: input.userId,
			jobId: row.id,
			scheduleType: row.record.schedule.type,
			reason: 'fenced_claim_superseded',
		})
		return {
			settled: false,
			nextRunAt: row.record.nextRunAt,
			error,
		}
	}
	const existing = await getJobRunObservability({
		env: input.env,
		userId: input.userId,
		jobId: row.id,
	})
	const alreadyRecordedForSlot =
		existing?.lastRunAt === slotAt &&
		existing.lastRunStatus === 'error' &&
		existing.lastRunError === error
	const recorded = alreadyRecordedForSlot
		? existing
		: await upsertJobRunObservability({
				env: input.env,
				userId: input.userId,
				outcome: {
					jobId: row.id,
					status: 'error',
					ranAt: slotAt,
					error,
					durationMs: 0,
				},
			})
	const runLogConfigured = Boolean((input.env as Partial<Env>).RUN_LOG)
	if (runLogConfigured && !recorded) {
		const nextRunAt = computeJobRetryAt({
			now: input.now,
			retryCount: row.retry_count,
		})
		const settled = await store.retryClaimedJob({
			userId: input.userId,
			jobId: row.id,
			claimToken: input.claimToken,
			nextRunAt,
		})
		logJobSchedulerEvent({
			event: settled
				? 'scheduled_job_skip_observability_failed'
				: 'claim_lost_before_skip_transition',
			userId: input.userId,
			jobId: row.id,
			scheduleType: row.record.schedule.type,
			reason: settled
				? 'observability_upsert_failed'
				: 'fenced_claim_superseded',
			errorMessage: settled ? error : undefined,
		})
		return { settled, nextRunAt, error }
	}
	const nextRunAt =
		row.record.schedule.type === 'once' || !scheduledFor
			? computeJobRetryAt({
					now: input.now,
					retryCount: row.retry_count,
				})
			: computeNextRunAt({
					schedule: row.record.schedule,
					timezone: row.record.timezone,
					from: input.now,
				})
	const settled =
		row.record.schedule.type === 'once' || !scheduledFor
			? await store.retryClaimedJob({
					userId: input.userId,
					jobId: row.id,
					claimToken: input.claimToken,
					nextRunAt,
				})
			: await store.finalizeClaimedJob({
					userId: input.userId,
					job: {
						...row.record,
						updatedAt: nowIso,
						lastRunAt: slotAt,
						lastRunStatus: 'error',
						lastRunError: error,
						nextRunAt,
					},
					claimToken: input.claimToken,
					scheduledFor,
				})
	logJobSchedulerEvent({
		event: settled
			? 'scheduled_job_skipped'
			: 'claim_lost_before_skip_transition',
		userId: input.userId,
		jobId: row.id,
		scheduleType: row.record.schedule.type,
		reason: settled ? 'no_enablement_on' : 'fenced_claim_superseded',
		errorMessage: settled ? error : undefined,
	})
	return { settled, nextRunAt, error }
}

async function executeClaimedScheduledJobRun(input: {
	env: Env
	row: JobRow
	scheduledFor: string
	source: RequestSource
	idempotencyKey: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<JobExecutionOutcome> {
	const { idempotencyKey } = input
	const attribution = await resolveScheduledJobRunAttribution({
		env: input.env,
		job: input.row.record,
	}).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	const claim = await claimRunRecord({
		env: input.env,
		userId: input.row.record.userId,
		context: {
			surface: 'job',
			name: input.row.record.name,
			jobId: input.row.record.id,
			storageId: input.row.record.storageId,
			sourceId: attribution.sourceId,
			publishedCommit: attribution.publishedCommit,
			packageId: attribution.packageId,
			kodyId: attribution.kodyId,
			idempotencyKey,
			metadata: {
				scheduledFor: input.scheduledFor,
			},
		},
	})
	try {
		const outcome = await executeOrReplayScheduledJobRun({
			claim,
			execute: async (handle) =>
				executeJobOnce({
					env: input.env,
					job: input.row.record,
					source: input.source,
					callerContext: resolveScheduledJobCallerContext({
						callerContext: input.row.callerContext,
					}),
					waitUntil: input.waitUntil,
					runRecordHandle: handle,
					idempotencyKey,
				}),
		})
		if (claim?.claimed) {
			const retained = await getRunRecord({
				env: input.env,
				userId: claim.handle.userId,
				runId: claim.handle.id,
			}).catch(() => null)
			if (!retained || retained.run.status === 'running') {
				await finishRunRecord({
					env: input.env,
					handle: claim.handle,
					status: outcome.execution.ok ? 'success' : 'error',
					logs: outcome.execution.logs,
					...(outcome.execution.ok
						? { result: outcome.execution.result }
						: { error: outcome.execution.error }),
				})
			}
		}
		return outcome
	} catch (error) {
		if (claim?.claimed && error instanceof TransientJobExecutionError) {
			await abandonRunRecord({
				env: input.env,
				handle: claim.handle,
			})
		}
		throw error
	}
}

export async function runDueJobsForUser(input: {
	env: Env
	userId: OwnerId
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		async write() {
			const now = input.now ?? new Date()
			const nowIso = now.toISOString()
			await jobsData(input.env).disableExpiredJobsForUser({
				userId: input.userId,
				nowIso,
			})
			const dueRows = await jobsData(input.env).listDueJobs({
				userId: input.userId,
				nowIso,
			})
			if (dueRows.length === 0) {
				logJobSchedulerEvent({
					event: 'run_due_jobs_empty',
					userId: input.userId,
					dueJobCount: 0,
					reason: 'no_due_jobs',
				})
				return {
					dueJobCount: 0,
					successCount: 0,
					errorCount: 0,
					jobOutcomes: [] satisfies Array<SchedulerJobOutcomeLog>,
				}
			}
			let claimedJobCount = 0
			let successCount = 0
			let errorCount = 0
			const jobOutcomes: Array<SchedulerJobOutcomeLog> = []
			for (const dueRow of dueRows) {
				const claimToken = crypto.randomUUID()
				const claimNow = input.now ?? new Date()
				const row = await jobsData(input.env).claimJob({
					userId: input.userId,
					jobId: dueRow.id,
					nowMs: claimNow.valueOf(),
					claimToken,
				})
				if (!row?.claimed_scheduled_for) {
					continue
				}
				claimedJobCount += 1
				try {
					const claimed = await executeClaimedScheduledJob({
						env: input.env,
						row,
						claimToken,
						scheduledFor: row.claimed_scheduled_for,
						waitUntil: input.waitUntil,
					})
					const scheduledOutcome = claimed.outcome
					if (!scheduledOutcome) {
						const skipped = await deferClaimedJobWithoutEnablement({
							env: input.env,
							userId: input.userId,
							row,
							claimToken,
							now,
							skipped: claimed.skipped,
						})
						if (skipped.settled) {
							errorCount += 1
							jobOutcomes.push({
								jobId: row.id,
								scheduleType: row.record.schedule.type,
								outcome: 'failure',
								nextRunAt: skipped.nextRunAt,
								deleted: false,
								error: skipped.error,
							})
						}
						continue
					}
					const result = await processDueJobs({
						jobs: [row.record],
						now,
						async executeJob() {
							return scheduledOutcome
						},
					})
					const updated = result.saveJobs[0]
					if (!updated) {
						throw new Error(
							`Scheduled job "${row.id}" produced no final job state.`,
						)
					}
					const finalized = await jobsData(input.env).finalizeClaimedJob({
						userId: input.userId,
						job: updated,
						claimToken,
						scheduledFor: row.claimed_scheduled_for,
					})
					if (!finalized) {
						// Ordinary edits clear claim_token; lease reclaim can
						// also supersede this runner. The fence worked — do not
						// fail the alarm or abort remaining due jobs.
						logJobSchedulerEvent({
							event: 'claim_lost_before_finalization',
							userId: input.userId,
							jobId: row.id,
							scheduleType: row.record.schedule.type,
							reason: 'fenced_claim_superseded',
						})
						continue
					}
					successCount += result.successCount
					errorCount += result.errorCount
					jobOutcomes.push(...result.jobOutcomes)
				} catch (error) {
					if (!(error instanceof TransientJobExecutionError)) {
						throw error
					}
					const retryAt = computeJobRetryAt({
						now: input.now ?? new Date(),
						retryCount: row.retry_count,
					})
					const retried = await jobsData(input.env).retryClaimedJob({
						userId: input.userId,
						jobId: row.id,
						claimToken,
						nextRunAt: retryAt,
					})
					if (!retried) {
						logJobSchedulerEvent({
							event: 'claim_lost_before_retry_transition',
							userId: input.userId,
							jobId: row.id,
							scheduleType: row.record.schedule.type,
							reason: 'fenced_claim_superseded',
						})
						continue
					}
					errorCount += 1
					jobOutcomes.push({
						jobId: row.id,
						scheduleType: row.record.schedule.type,
						outcome: 'failure',
						nextRunAt: retryAt,
						deleted: false,
						error: error.message,
					})
				}
			}
			return {
				dueJobCount: claimedJobCount,
				successCount,
				errorCount,
				jobOutcomes,
			}
		},
	})
}

export async function getNextRunnableJob(input: {
	env: Env
	userId: OwnerId
	now?: Date
}) {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	await jobsData(input.env).disableExpiredJobsForUser({
		userId: input.userId,
		nowIso,
	})
	const row = await jobsData(input.env).getNextRunnableJob({
		userId: input.userId,
		nowIso,
	})
	return row
		? {
				...row.record,
				nextRunAt: row.schedulerWakeAt,
			}
		: null
}
