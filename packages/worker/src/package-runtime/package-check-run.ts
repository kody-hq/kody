import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	knownUnmappableCredentials,
	loadOnePackageUnmappableCredentials,
	unmappableCredentialOwnerNotice,
} from '#worker/credentials/package-unmappable-credentials.ts'
import { findPackageJobIntervalFloorViolation } from '#worker/jobs/package-job-interval-floor.ts'
import { resolveOwnedPackageSource } from '#mcp/capabilities/packages/resolve-package-source.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	deferredBundleCheckMessage,
	type RepoCheckRunResult,
} from '#worker/repo/checks.ts'
import { createIsolatedArtifactRebuildRunner } from '#worker/repo/isolated-artifact-rebuild.ts'
import { runPackageCheckArtifactBuild } from '#worker/repo/package-check-artifact-build.ts'
import {
	packageCheckUploadKey,
	packageRunResultKey,
	type PackageCheckPrepareRequest,
	type PackageCheckPrepareResult,
} from '#worker/repo/package-check-upload.ts'
import {
	bindPublishHeavyWork,
	createIsolatedPublishWorkRunner,
} from '#worker/repo/publish-work.ts'
import {
	createRepoChecksError,
	RepoChecksPlatformError,
} from '#worker/repo/repo-checks-failed-error.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import type { WorkflowProjectionProgress } from '#worker/run-records/workflow-projection.ts'

export {
	durablePackageCheckWorkflowCode,
	packageCheckWorkflowName,
} from './package-check-run.constants.ts'

type CheckResult = RepoCheckRunResult['results'][number]

/** The full check answer, stored in R2 under the run id. */
export type PackageCheckRunResult = {
	kind: 'packageCheck'
	ok: boolean
	package_name: string | null
	checks: Array<{ kind: CheckResult['kind']; ok: boolean; message: string }>
	notices: Array<string>
}

/** What the run keeps as its workflow result: small, with no check text. */
export type PackageCheckRunSummary = {
	ok: boolean
	package_name: string | null
	failed_checks: number
}

export type PackageCheckRunParams = {
	upload_id: string
	owner_scope: string
	owner_email: string | null
	base_url: string
}

export function readPackageCheckRunParams(
	params: Record<string, unknown> | undefined,
): PackageCheckRunParams {
	const read = (key: string) => {
		const value = params?.[key]
		if (typeof value !== 'string' || !value) {
			throw new Error(`packageCheck run is missing "${key}".`)
		}
		return value
	}
	const email = params?.['owner_email']
	return {
		upload_id: read('upload_id'),
		owner_scope: read('owner_scope'),
		owner_email: typeof email === 'string' && email ? email : null,
		base_url: read('base_url'),
	}
}

type StepRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>

type PackageCheckPrepareStub = {
	runIsolatedPackageCheckPrepare(
		request: PackageCheckPrepareRequest,
	): Promise<PackageCheckPrepareResult>
}

type ExistingPackage = {
	packageId: string
	name: string
	source: Pick<EntitySourceRow, 'id' | 'manifest_path' | 'source_root'>
}

async function findExistingPackage(input: {
	env: Env
	userId: OwnerId
	ownerScope: string
	packageName: string | null
}): Promise<ExistingPackage | null> {
	if (!input.packageName) return null
	try {
		const existing = await resolveOwnedPackageSource({
			db: input.env.APP_DB,
			userId: input.userId,
			ownerScope: input.ownerScope,
			args: { kody_id: getPackageNameLeaf(input.packageName) },
		})
		return {
			packageId: existing.packageId,
			name: existing.name,
			source: {
				id: existing.source.id,
				manifest_path: existing.source.manifest_path,
				source_root: existing.source.source_root,
			},
		}
	} catch {
		return null
	}
}

async function findJobIntervalFloorViolation(input: {
	env: Env
	userId: OwnerId
	params: PackageCheckRunParams
	manifestContent: string | null
	sourceId?: string
}) {
	if (input.manifestContent === null) return null
	let jobs
	try {
		jobs = parseAuthoredPackageJson({
			content: input.manifestContent,
			expectedPackageScope: input.params.owner_scope,
		}).kody.jobs
	} catch {
		// The manifest check reports the parse error.
		return null
	}
	if (!jobs) return null
	return await findPackageJobIntervalFloorViolation({
		env: input.env,
		userId: input.userId,
		email: input.params.owner_email,
		...(input.sourceId ? { sourceId: input.sourceId } : {}),
		jobs,
	})
}

/**
 * A durable `packageCheck` run: what a git-push publish does after its clone,
 * saving nothing. Each phase is its own durable step and the heavy ones run in
 * throwaway `REPO_SESSION` isolates through the same publish work runner a
 * publish uses, so this isolate never holds the package tree. The full result
 * goes to R2 under the run id; the returned summary is all the workflow keeps.
 */
export async function runPackageCheckWorkflow(input: {
	env: Env
	userId: OwnerId
	workflowId: string
	params: PackageCheckRunParams
	/** Caller the run acts as, for the unmappable-credentials notice. */
	request: RequestContext | null
	step: StepRunner
	reportProgress: (progress: WorkflowProjectionProgress) => Promise<void>
}): Promise<PackageCheckRunSummary> {
	const { env, userId, params, step } = input
	const bucket = env.REPO_SESSION_BLOBS
	const uploadKey = packageCheckUploadKey(userId, params.upload_id)
	const workRunner = createIsolatedPublishWorkRunner(env)
	if (!workRunner) {
		throw new Error(
			'packageCheck needs the REPO_SESSION and BUNDLE_ARTIFACTS_KV bindings.',
		)
	}
	const artifactRunner = createIsolatedArtifactRebuildRunner(env)
	const progress = async (value: WorkflowProjectionProgress) => {
		// Progress is advisory; a failed write must not fail the check.
		await input.reportProgress(value).catch(() => {})
	}
	const finish = async (result: Omit<PackageCheckRunResult, 'kind'>) =>
		await step('store check result', async () => {
			await bucket.put(
				packageRunResultKey(userId, input.workflowId),
				JSON.stringify({
					kind: 'packageCheck',
					...result,
				} satisfies PackageCheckRunResult),
				{ httpMetadata: { contentType: 'application/json' } },
			)
			await bucket.delete(uploadKey)
			return {
				ok: result.ok,
				package_name: result.package_name,
				failed_checks: result.checks.filter((check) => !check.ok).length,
			}
		})

	await progress({ phase: 'prepare', message: 'Reading the uploaded tree.' })
	const prepared = await step('prepare uploaded tree', async () => {
		const stub = env.REPO_SESSION.get(
			env.REPO_SESSION.idFromName(
				`package-check-prepare-${userId}-${crypto.randomUUID()}`,
			),
		) as unknown as PackageCheckPrepareStub
		return await stub.runIsolatedPackageCheckPrepare({
			userId,
			uploadId: params.upload_id,
		})
	})
	if (!prepared.ok) {
		return await finish({
			ok: false,
			package_name: prepared.packageName,
			notices: [],
			checks: [{ kind: 'manifest', ok: false, message: prepared.message }],
		})
	}
	try {
		const existing = await step('resolve existing package', async () =>
			findExistingPackage({
				env,
				userId,
				ownerScope: params.owner_scope,
				packageName: prepared.packageName,
			}),
		)
		await progress({
			phase: 'checks',
			message: `Running publish checks on ${prepared.fileCount} files.`,
		})
		const checks = await step('run publish checks', async () => {
			const result = await bindPublishHeavyWork({
				runner: workRunner,
				stagingKey: prepared.stagingKey,
				userId,
			}).runChecks({
				mode: 'authoring',
				manifestPath: 'package.json',
				sourceRoot: '',
				baseUrl: params.base_url,
				expectedPackageScope: params.owner_scope,
				...(existing ? { sourceId: existing.source.id } : {}),
				...(prepared.artifactStagingKey
					? { deferBundleCheckToRebuild: true }
					: {}),
			})
			return { ok: result.ok, results: result.results }
		})
		const results = [...checks.results]
		let ok = checks.ok
		const deferredIndex = results.findIndex(
			(result) =>
				result.kind === 'bundle' &&
				result.message === deferredBundleCheckMessage,
		)
		if (
			ok &&
			deferredIndex !== -1 &&
			artifactRunner &&
			prepared.artifactStagingKey &&
			prepared.manifestContent !== null
		) {
			const artifactStagingKey = prepared.artifactStagingKey
			const manifestContent = prepared.manifestContent
			await progress({
				phase: existing ? 'artifact_reuse_scan' : 'artifact_build',
				message: existing
					? 'Finding artifacts unchanged since the published commit.'
					: 'Building runtime artifacts.',
			})
			const built = await step('build runtime artifacts', async () =>
				runPackageCheckArtifactBuild({
					runner: artifactRunner,
					stagingKey: artifactStagingKey,
					manifestContent,
					userId,
					baseUrl: params.base_url,
					expectedPackageScope: params.owner_scope,
					...(existing
						? {
								rootPackageId: existing.packageId,
								reuseSource: existing.source,
							}
						: {}),
					onChunkDone: async ({ done, total }) =>
						progress({
							phase: 'artifact_build',
							message: `Built ${done} of ${total} artifact chunks.`,
							done,
							total,
						}),
				}),
			)
			results[deferredIndex] = built
			if (!built.ok) ok = false
		}
		// Kody infrastructure failures are not package diagnostics: throw so
		// the run errors instead of reading as checks the author must fix.
		const checksError = ok ? null : createRepoChecksError(results)
		if (checksError instanceof RepoChecksPlatformError) throw checksError
		await progress({ phase: 'finish', message: 'Collecting notices.' })
		const wrapUp = await step('job floor and notices', async () => {
			// Publish refuses these only after its checks, when it syncs jobs.
			const jobFloorMessage = await findJobIntervalFloorViolation({
				env,
				userId,
				params,
				manifestContent: prepared.manifestContent,
				...(existing ? { sourceId: existing.source.id } : {}),
			})
			const unmappable = existing
				? knownUnmappableCredentials(
						await loadOnePackageUnmappableCredentials({
							env,
							orgId: userId,
							packageId: existing.packageId,
							request: input.request,
						}),
					)
				: []
			return {
				jobFloorMessage,
				notices:
					existing && unmappable.length > 0
						? [
								unmappableCredentialOwnerNotice({
									packageLabel: `Package "${existing.name}"`,
									credentials: unmappable,
								}),
							]
						: [],
			}
		})
		if (wrapUp.jobFloorMessage) {
			results.push({
				kind: 'manifest',
				ok: false,
				message: wrapUp.jobFloorMessage,
			})
			ok = false
		}
		return await finish({
			ok,
			package_name: prepared.packageName,
			notices: wrapUp.notices,
			checks: results.map((result) => ({
				kind: result.kind,
				ok: result.ok,
				message: result.message,
			})),
		})
	} finally {
		// Best effort: staged trees also expire through their KV TTL.
		await workRunner.discard(prepared.stagingKey).catch(() => {})
		if (artifactRunner && prepared.artifactStagingKey) {
			await artifactRunner.discard(prepared.artifactStagingKey).catch(() => {})
		}
	}
}
