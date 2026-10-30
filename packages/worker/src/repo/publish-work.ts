import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { shouldStoreArtifactBlobAsLatin1 } from '#universal/package-file-media.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import {
	requireCredentialNeedsApproval,
	type CredentialNeedsApprovalRequired,
	type PausedExternalPublish,
	type PausedSessionPublish,
} from '#worker/credentials/credential-needs-approval.ts'
import { storePublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { storePublishedCredentialStamp } from '#worker/credentials/credential-stamp-store.ts'
import { loadCredentialAllowedPackagesPublishWarningNotice } from '#worker/credentials/credential-allowed-packages-publish-warning.ts'
import { loadSecretMountCompatNotice } from '#worker/package-runtime/secret-mount-compat.ts'
import {
	hasPublishedRuntimeArtifacts,
	loadPublishedSourceSnapshot,
	publishedSourceSnapshotFilesMatch,
	writePublishedPublishChecksVersion,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	type AuthoredPackageJson,
	type PackageCredentialSlot,
} from '#worker/package-registry/types.ts'
import { runAuthoringPublishChecks } from './authoring-publish-checks.ts'
import {
	createSnapshotFilesWorkspace,
	runRepoChecks,
	type RepoCheckKind,
	type RepoCheckResult,
} from './checks.ts'
import { credentialPatternNoticeForFiles } from './credential-pattern-check.ts'
import {
	authoringChecksResourceLimitMessage,
	isolatedCheckStagingKeyBelongsToUser,
	isolatedCheckStagingKeyForUser,
	readLastCheckStep,
} from './isolated-check-phases.ts'
import {
	publishComputeLimitMessage,
	type RepoCheckStep,
} from './isolated-runner-limit-message.ts'
import { omitKodyIgnoredFiles } from './kodyignore.ts'
import {
	largestNonRuntimePaths,
	type LargePathHint,
} from './publish-size-hints.ts'
import { type PublishPhaseTimings } from './publish-phase-timing.ts'
import { type EntitySourceRow } from './types.ts'

/**
 * Heavy publish work (checks, credential scans and stamps, credential-needs
 * closures, the published snapshot write, and the saved-package projection)
 * runs in fresh, throwaway `REPO_SESSION` isolates instead of the session /
 * external-publish Durable Object (kody-hq/kody#4078). The coordinating
 * Durable Object keeps only locking, session state, and git refs.
 *
 * Each step gets its own isolate, so each step gets its own CPU and memory
 * budget: a large package can no longer stack every scan into one isolate
 * and trip the Durable Object CPU limit on every retry. The file tree is
 * staged once in KV (chunked, short TTL) and each step reads it by key, so
 * RPC payloads stay small.
 */

const stagingTtlSeconds = 15 * 60
/** Below the 25 MiB KV value limit, with headroom. */
const stagingChunkMaxBytes = 20 * 1024 * 1024

type StagedPublishWorkManifest = {
	version: 1
	chunkCount: number
	byteLength: number
}

function stagingChunkKey(stagingKey: string, index: number) {
	return `${stagingKey}:chunk:${index}`
}

/**
 * Stage a file tree in KV for publish work isolates. Publish snapshots can be
 * up to the Artifacts pack ceiling, past one KV value, so the encoded JSON is
 * split into byte chunks under a small manifest entry.
 */
export async function stagePublishWorkFiles(input: {
	kv: KVNamespace
	userId: string
	files: Record<string, string>
}) {
	const stagingKey = isolatedCheckStagingKeyForUser(input.userId)
	const bytes = new TextEncoder().encode(JSON.stringify(input.files))
	const chunkCount = Math.max(
		1,
		Math.ceil(bytes.byteLength / stagingChunkMaxBytes),
	)
	for (let index = 0; index < chunkCount; index += 1) {
		const chunk = bytes.slice(
			index * stagingChunkMaxBytes,
			(index + 1) * stagingChunkMaxBytes,
		)
		await input.kv.put(stagingChunkKey(stagingKey, index), chunk.buffer, {
			expirationTtl: stagingTtlSeconds,
		})
	}
	const manifest: StagedPublishWorkManifest = {
		version: 1,
		chunkCount,
		byteLength: bytes.byteLength,
	}
	await input.kv.put(stagingKey, JSON.stringify(manifest), {
		expirationTtl: stagingTtlSeconds,
	})
	return stagingKey
}

export async function loadStagedPublishWorkFiles(input: {
	kv: KVNamespace
	stagingKey: string
}): Promise<Record<string, string> | null> {
	const manifest = await input.kv.get<StagedPublishWorkManifest>(
		input.stagingKey,
		'json',
	)
	if (!manifest || manifest.version !== 1) return null
	const bytes = new Uint8Array(manifest.byteLength)
	let offset = 0
	for (let index = 0; index < manifest.chunkCount; index += 1) {
		const chunk = await input.kv.get(
			stagingChunkKey(input.stagingKey, index),
			'arrayBuffer',
		)
		if (!chunk) return null
		bytes.set(new Uint8Array(chunk), offset)
		offset += chunk.byteLength
	}
	if (offset !== manifest.byteLength) return null
	return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>
}

async function discardStagedPublishWorkFiles(input: {
	kv: KVNamespace
	stagingKey: string
}) {
	try {
		const manifest = await input.kv.get<StagedPublishWorkManifest>(
			input.stagingKey,
			'json',
		)
		await input.kv.delete(input.stagingKey)
		for (let index = 0; index < (manifest?.chunkCount ?? 0); index += 1) {
			await input.kv.delete(stagingChunkKey(input.stagingKey, index))
		}
	} catch {
		// Best effort: staging entries expire via their TTL anyway.
	}
}

/**
 * Check workspace over a snapshot file map (`bytesToSnapshotString`
 * encoding). Binary blobs are passed by size only, the same shape
 * `packageCheck` (`kody dev check`) checks, so publish and dev check agree.
 */
export function createPublishSnapshotCheckWorkspace(
	files: Record<string, string>,
) {
	const textFiles: Record<string, string> = {}
	const binaryFileSizes: Record<string, number> = {}
	for (const [path, content] of Object.entries(files)) {
		if (content.includes('\0') || shouldStoreArtifactBlobAsLatin1(path)) {
			binaryFileSizes[path] = content.length
		} else {
			textFiles[path] = content
		}
	}
	return createSnapshotFilesWorkspace(textFiles, { binaryFileSizes })
}

export type PublishWorkChecksInput = {
	/** Paths relative to the staged tree root (repo-relative). */
	manifestPath: string
	sourceRoot: string
	baseUrl: string
	sourceId?: string
	expectedPackageScope?: string
	/**
	 * `authoring`: the authoring publish checks (`runAuthoringPublishChecks`).
	 * `session`: `runRepoChecks` with the session lane's options.
	 */
	mode: 'authoring' | 'session'
	deferBundleCheckToRebuild?: boolean
	requirePackageDocs?: boolean
	enforceCredentialStamp?: boolean
}

export type PublishWorkChecksResult = {
	ok: boolean
	results: Array<RepoCheckResult>
	manifest: AuthoredPackageJson | null
	phaseTimings?: PublishPhaseTimings
}

export type PublishWorkNoticesInput = {
	source: EntitySourceRow
	nextCommit: string
	baseUrl: string
	includePatternNotice?: boolean
	slots?: Record<string, PackageCredentialSlot>
}

export type PublishWorkNotices = {
	patternNotice: string | null
	secretMountCompat: string | null
	allowedPackagesPublishNotice: string | null
}

export type PublishWorkApprovalInput = {
	source: EntitySourceRow
	pendingCommit: string
	requestedByUserId?: string | null
	pausedSession?: PausedSessionPublish
	pausedExternalPublish?: PausedExternalPublish
}

export type PublishWorkProjectionInput = {
	source: EntitySourceRow
	baseUrl: string
	rebuildArtifacts: boolean
	firstPublish: boolean
	creatorUserId: string | null
	/** False for a same-commit finalize, which is not a new publish. */
	writeAudit: boolean
	auditUserId: string | null
}

type PublishWorkOps = {
	checks: { input: PublishWorkChecksInput; result: PublishWorkChecksResult }
	notices: { input: PublishWorkNoticesInput; result: PublishWorkNotices }
	approval: {
		input: PublishWorkApprovalInput
		result: CredentialNeedsApprovalRequired | null
	}
	'write-snapshot': {
		input: { source: EntitySourceRow; publishedCommit: string }
		result: { written: boolean }
	}
	'store-credential-needs': {
		input: { source: EntitySourceRow; publishedCommit: string }
		result: null
	}
	'store-credential-stamp': {
		input: { source: EntitySourceRow; publishedCommit: string }
		result: { stamped: boolean }
	}
	'refresh-projection': { input: PublishWorkProjectionInput; result: null }
	'refresh-already-published-snapshot': {
		input: { source: EntitySourceRow; publishedCommit: string }
		result: { forceArtifactRebuild: boolean }
	}
}

export type PublishWorkOp = keyof PublishWorkOps

export type PublishWorkRequest = {
	[Op in PublishWorkOp]: {
		op: Op
		stagingKey: string
		userId: OwnerId
		input: PublishWorkOps[Op]['input']
	}
}[PublishWorkOp]

type PublishWorkRequestFor<Op extends PublishWorkOp> = Extract<
	PublishWorkRequest,
	{ op: Op }
>

export type PublishWorkResult<Op extends PublishWorkOp> =
	PublishWorkOps[Op]['result']

export type ExternalRefCloneRequest = {
	userId: OwnerId
	source: EntitySourceRow
	commit: string
	expectedHead?: string | null
	/** Published commit to test ancestry against before the clone is dropped. */
	previousCommit: string | null
}

export type ExternalRefCloneResult = {
	stagingKey: string
	headCommit: string | null
	/** Null when `previousCommit` was null or equal to `commit`. */
	isFastForward: boolean | null
	phaseTimings: PublishPhaseTimings
}

/** Clone + collect, run wherever the runner runs it. */
export type ExternalRefCloneFiles = (
	request: ExternalRefCloneRequest,
) => Promise<{
	files: Record<string, string>
	headCommit: string | null
	isFastForward: boolean | null
	phaseTimings: PublishPhaseTimings
}>

/**
 * The heavy publish steps over one staged file tree. External publish,
 * session publish, and finalize call these instead of the scans directly.
 */
export type PublishHeavyWork = {
	runChecks(input: PublishWorkChecksInput): Promise<PublishWorkChecksResult>
	loadNotices(input: PublishWorkNoticesInput): Promise<PublishWorkNotices>
	requireApproval(
		input: PublishWorkApprovalInput,
	): Promise<CredentialNeedsApprovalRequired | null>
	writeSnapshot(input: {
		source: EntitySourceRow
		publishedCommit: string
	}): Promise<{ written: boolean }>
	storeCredentialNeeds(input: {
		source: EntitySourceRow
		publishedCommit: string
	}): Promise<void>
	storeCredentialStamp(input: {
		source: EntitySourceRow
		publishedCommit: string
	}): Promise<{ stamped: boolean }>
	refreshProjection(input: PublishWorkProjectionInput): Promise<void>
	refreshAlreadyPublishedSnapshot(input: {
		source: EntitySourceRow
		publishedCommit: string
	}): Promise<{ forceArtifactRebuild: boolean }>
}

/**
 * Inline implementation over files already in this isolate. Worker-side
 * callers (published source sync, ref repair) use it, and publish work
 * isolates run it for the one step they were started for.
 *
 * `publishedFiles` is the `.kodyignore`-filtered published set; `checks`
 * read `checkFiles` (or `checkWorkspace`) and apply `.kodyignore` themselves.
 */
export function createInlinePublishHeavyWork(input: {
	env: Env
	userId?: OwnerId
	publishedFiles: Record<string, string>
	/** Source root the published set is keyed under, for scans. */
	publishedFilesSourceRoot?: string
	checkFiles?: Record<string, string>
	checkWorkspace?: Parameters<typeof runRepoChecks>[0]['workspace']
	onStep?: (step: RepoCheckStep) => Promise<void>
}): PublishHeavyWork {
	const { env, publishedFiles } = input
	return {
		async runChecks(checksInput) {
			const workspace =
				input.checkWorkspace ??
				createPublishSnapshotCheckWorkspace(input.checkFiles ?? publishedFiles)
			if (!input.userId) {
				throw new Error('Publish checks need the owning user id.')
			}
			const phaseTimings: PublishPhaseTimings = {}
			const common = {
				workspace,
				manifestPath: checksInput.manifestPath,
				sourceRoot: checksInput.sourceRoot,
				env,
				baseUrl: checksInput.baseUrl,
				userId: input.userId,
				...(checksInput.sourceId ? { sourceId: checksInput.sourceId } : {}),
				...(checksInput.expectedPackageScope !== undefined
					? { expectedPackageScope: checksInput.expectedPackageScope }
					: {}),
				phaseTimings,
				...(input.onStep ? { onStep: input.onStep } : {}),
			}
			const checks =
				checksInput.mode === 'authoring'
					? await runAuthoringPublishChecks({
							...common,
							...(checksInput.deferBundleCheckToRebuild === true
								? { deferBundleCheckToRebuild: true }
								: {}),
						})
					: await runRepoChecks({
							...common,
							...(checksInput.requirePackageDocs === false
								? { requirePackageDocs: false }
								: {}),
							...(checksInput.enforceCredentialStamp === false
								? { enforceCredentialStamp: false }
								: {}),
						})
			return {
				ok: checks.ok,
				results: checks.results,
				manifest: checks.manifest,
				phaseTimings,
			}
		},
		async loadNotices(noticesInput) {
			const { source } = noticesInput
			if (source.entity_kind !== 'package') {
				return {
					patternNotice: null,
					secretMountCompat: null,
					allowedPackagesPublishNotice: null,
				}
			}
			const patternNotice = noticesInput.includePatternNotice
				? credentialPatternNoticeForFiles(
						publishedFiles,
						input.publishedFilesSourceRoot ?? source.source_root,
					)
				: null
			const secretMountCompat = await loadSecretMountCompatNotice({
				env,
				userId: source.user_id,
				sourceId: source.id,
				nextCommit: noticesInput.nextCommit,
				nextFiles: publishedFiles,
				previousCommit: source.published_commit,
				sourceRoot: source.source_root,
			})
			// Independent of the locked-publish gate: lookup/scan failures
			// never change lock or approve results.
			const allowedPackagesPublishNotice =
				await loadCredentialAllowedPackagesPublishWarningNotice({
					env,
					baseUrl: noticesInput.baseUrl,
					userId: source.user_id as OwnerId,
					packageId: source.entity_id,
					files: publishedFiles,
					sourceRoot: input.publishedFilesSourceRoot,
					...(noticesInput.slots ? { slots: noticesInput.slots } : {}),
				})
			return { patternNotice, secretMountCompat, allowedPackagesPublishNotice }
		},
		async requireApproval(approvalInput) {
			return await requireCredentialNeedsApproval({
				env,
				source: approvalInput.source,
				pendingCommit: approvalInput.pendingCommit,
				files: publishedFiles,
				requestedByUserId: approvalInput.requestedByUserId,
				...(approvalInput.pausedSession
					? { pausedSession: approvalInput.pausedSession }
					: {}),
				...(approvalInput.pausedExternalPublish
					? { pausedExternalPublish: approvalInput.pausedExternalPublish }
					: {}),
			})
		},
		async writeSnapshot(snapshotInput) {
			if (!hasPublishedRuntimeArtifacts(env)) return { written: false }
			await writePublishedSourceSnapshot({
				env,
				source: {
					...snapshotInput.source,
					published_commit: snapshotInput.publishedCommit,
				},
				files: publishedFiles,
			})
			return { written: true }
		},
		async storeCredentialNeeds(needsInput) {
			await storePublishedCredentialNeeds({
				env,
				source: needsInput.source,
				publishedCommit: needsInput.publishedCommit,
				files: publishedFiles,
			})
		},
		async storeCredentialStamp(stampInput) {
			const stamp = await storePublishedCredentialStamp({
				env,
				source: stampInput.source,
				publishedCommit: stampInput.publishedCommit,
				files: publishedFiles,
			})
			// Only seal the checker version after a successful stamp write so a
			// failed store cannot leave a "current" version over a missing stamp.
			if (stamp) {
				await writePublishedPublishChecksVersion({
					env,
					sourceId: stampInput.source.id,
					publishedCommit: stampInput.publishedCommit,
				})
			}
			return { stamped: Boolean(stamp) }
		},
		async refreshProjection(projectionInput) {
			const { source } = projectionInput
			await refreshSavedPackageProjection({
				env,
				baseUrl: projectionInput.baseUrl,
				userId: source.user_id,
				// No account email in this publish path; plan lookup fails open per entitlements.md.
				packageId: source.entity_id,
				sourceId: source.id,
				rebuildArtifacts: projectionInput.rebuildArtifacts,
				// Always pass the published file set so skills indexing runs even
				// when artifact rebuild is deferred (`rebuildArtifacts: false`).
				sourceFiles: publishedFiles,
				firstPublish: projectionInput.firstPublish,
				creatorUserId: projectionInput.creatorUserId,
				audit: projectionInput.writeAudit
					? optionalOrgAuditWriter(env, {
							userId: projectionInput.auditUserId,
						})
					: null,
			})
		},
		async refreshAlreadyPublishedSnapshot(refreshInput) {
			// D1 stays a no-op. Rewrite the KV snapshot only when the tip's
			// files differ from it, so a prior finalize that tagged this commit
			// with stale files cannot keep winning artifact rebuilds.
			const { source, publishedCommit } = refreshInput
			if (!hasPublishedRuntimeArtifacts(env)) {
				return { forceArtifactRebuild: false }
			}
			if (typeof publishedFiles[source.manifest_path] !== 'string') {
				return { forceArtifactRebuild: false }
			}
			const publishedSource = { ...source, published_commit: publishedCommit }
			const existingSnapshot = await loadPublishedSourceSnapshot({
				env,
				userId: source.user_id,
				source: publishedSource,
			})
			if (publishedSourceSnapshotFilesMatch(existingSnapshot, publishedFiles)) {
				return { forceArtifactRebuild: false }
			}
			// Missing snapshot is the D1-finalize vs KV-write overlap: keep live
			// artifacts and do not force. Mismatch means this commit was tagged
			// with stale files: rewrite it (rebuild reads it) and stamp
			// invalidateArtifactsBefore so a later already_published cannot skip
			// leftovers. Rows are kept so invoke stays online.
			const snapshotExisted = existingSnapshot?.files != null
			await writePublishedSourceSnapshot({
				env,
				source: publishedSource,
				files: publishedFiles,
				invalidateExistingArtifacts: snapshotExisted,
			})
			return { forceArtifactRebuild: snapshotExisted }
		},
	}
}

const publishWorkOpSteps: Record<PublishWorkOp, RepoCheckStep> = {
	checks: 'source-walk',
	notices: 'credentials',
	approval: 'package-checks',
	'write-snapshot': 'finalize',
	'store-credential-needs': 'package-checks',
	'store-credential-stamp': 'credentials',
	'refresh-projection': 'finalize',
	'refresh-already-published-snapshot': 'finalize',
}

/** Run one publish work step over a file tree already in this isolate. */
export async function runPublishWorkStep<Op extends PublishWorkOp>(input: {
	env: Env
	request: PublishWorkRequestFor<Op>
	files: Record<string, string>
	onStep?: (step: RepoCheckStep) => Promise<void>
}): Promise<PublishWorkResult<Op>> {
	const { request, files } = input
	await input.onStep?.(publishWorkOpSteps[request.op])
	const source =
		'source' in request.input ? (request.input.source as EntitySourceRow) : null
	const work = createInlinePublishHeavyWork({
		env: input.env,
		userId: request.userId,
		publishedFiles: source
			? omitKodyIgnoredFiles(files, source.source_root)
			: files,
		...(source ? { publishedFilesSourceRoot: source.source_root } : {}),
		checkFiles: files,
		...(input.onStep ? { onStep: input.onStep } : {}),
	})
	const run = async (): Promise<unknown> => {
		const typed = request as PublishWorkRequest
		switch (typed.op) {
			case 'checks':
				return await work.runChecks(typed.input)
			case 'notices':
				return await work.loadNotices(typed.input)
			case 'approval':
				return await work.requireApproval(typed.input)
			case 'write-snapshot':
				return await work.writeSnapshot(typed.input)
			case 'store-credential-needs':
				await work.storeCredentialNeeds(typed.input)
				return null
			case 'store-credential-stamp':
				return await work.storeCredentialStamp(typed.input)
			case 'refresh-projection':
				await work.refreshProjection(typed.input)
				return null
			case 'refresh-already-published-snapshot':
				return await work.refreshAlreadyPublishedSnapshot(typed.input)
			default: {
				const exhaustive: never = typed
				throw new Error(
					`Unknown publish work step: ${String((exhaustive as { op?: unknown }).op)}`,
				)
			}
		}
	}
	return (await run()) as PublishWorkResult<Op>
}

/**
 * Body of the `RepoSession.runIsolatedPublishWork` RPC: load the staged tree
 * and run one step in this throwaway isolate.
 */
export async function runStagedPublishWorkStep(input: {
	env: Env
	request: PublishWorkRequest
	onStep?: (step: RepoCheckStep) => Promise<void>
}): Promise<unknown> {
	if (
		!isolatedCheckStagingKeyBelongsToUser({
			stagingKey: input.request.stagingKey,
			userId: input.request.userId,
		})
	) {
		throw new Error(
			'Publish work staging key does not belong to the requesting user.',
		)
	}
	const files = await loadStagedPublishWorkFiles({
		kv: input.env.BUNDLE_ARTIFACTS_KV,
		stagingKey: input.request.stagingKey,
	})
	if (!files) {
		throw new Error(
			'Publish work staging data expired or is missing; retry the publish.',
		)
	}
	return await runPublishWorkStep({
		env: input.env,
		request: input.request,
		files,
		...(input.onStep ? { onStep: input.onStep } : {}),
	})
}

export type PublishWorkRunner = {
	/** True when steps run in throwaway isolates (production bindings). */
	isolated: boolean
	stage(input: {
		userId: OwnerId
		files: Record<string, string>
	}): Promise<string>
	run<Op extends PublishWorkOp>(
		request: PublishWorkRequestFor<Op>,
	): Promise<PublishWorkResult<Op>>
	cloneExternalRef(
		request: ExternalRefCloneRequest,
	): Promise<ExternalRefCloneResult>
	discard(stagingKey: string): Promise<void>
}

type PublishWorkStub = {
	runIsolatedPublishWork(request: PublishWorkRequest): Promise<unknown>
	runIsolatedExternalRefClone(
		request: ExternalRefCloneRequest,
	): Promise<ExternalRefCloneResult>
	takeLastCheckStep(): Promise<RepoCheckStep | null>
}

function isResourceLimitReset(error: unknown) {
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

function repoCheckKindForStep(step: RepoCheckStep | null): RepoCheckKind {
	switch (step) {
		case 'credentials':
			return 'credentials'
		case 'lint':
			return 'lint'
		case 'typecheck':
			return 'typecheck'
		default:
			return 'bundle'
	}
}

/**
 * Best effort: names the biggest non-runtime files in a staged tree after a
 * step hit the memory/CPU limit, so the error can suggest `.kodyignore`.
 */
async function stagedLargestNonRuntimePaths(input: {
	kv: KVNamespace
	request: PublishWorkRequest
}): Promise<Array<LargePathHint>> {
	try {
		const files = await loadStagedPublishWorkFiles({
			kv: input.kv,
			stagingKey: input.request.stagingKey,
		})
		if (!files) return []
		const requestInput = input.request.input as {
			sourceRoot?: unknown
			source?: { source_root?: unknown }
		}
		const sourceRoot =
			typeof requestInput.sourceRoot === 'string'
				? requestInput.sourceRoot
				: typeof requestInput.source?.source_root === 'string'
					? requestInput.source.source_root
					: ''
		return largestNonRuntimePaths({ files, sourceRoot })
	} catch {
		return []
	}
}

/**
 * Runs each publish step on a fresh `REPO_SESSION` id. A step that still hits
 * the memory/CPU limit on its own becomes an actionable compute-limit error
 * (or a failed check for `checks`) naming the step, never a raw reset that
 * edge mapping would mistake for a storage outage. Returns null when the env
 * lacks the bindings (unit tests, minimal envs).
 */
export function createIsolatedPublishWorkRunner(
	env: Env | undefined,
): PublishWorkRunner | null {
	const namespace = (
		env as (Env & { REPO_SESSION?: DurableObjectNamespace }) | undefined
	)?.REPO_SESSION
	const kv = (env as (Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }) | undefined)
		?.BUNDLE_ARTIFACTS_KV
	if (!namespace || !kv) return null
	const freshStub = (userId: string, label: string) =>
		namespace.get(
			namespace.idFromName(
				`isolated-publish-${label}-${userId}-${crypto.randomUUID()}`,
			),
		) as unknown as PublishWorkStub
	return {
		isolated: true,
		async stage(input) {
			return await stagePublishWorkFiles({
				kv,
				userId: input.userId,
				files: input.files,
			})
		},
		async run(request) {
			const stub = freshStub(request.userId, request.op)
			try {
				return (await stub.runIsolatedPublishWork(
					request,
				)) as PublishWorkResult<typeof request.op>
			} catch (error) {
				if (!isResourceLimitReset(error)) throw error
				const step =
					(await readLastCheckStep(stub)) ?? publishWorkOpSteps[request.op]
				const largestPaths = await stagedLargestNonRuntimePaths({
					kv,
					request,
				})
				if (request.op === 'checks') {
					return {
						ok: false,
						results: [
							{
								kind: repoCheckKindForStep(step),
								ok: false,
								message: authoringChecksResourceLimitMessage(
									step,
									largestPaths,
								),
							},
						],
						manifest: null,
					} satisfies PublishWorkChecksResult as PublishWorkResult<
						typeof request.op
					>
				}
				throw new Error(publishComputeLimitMessage(step, largestPaths), {
					cause: error,
				})
			}
		},
		async cloneExternalRef(request) {
			const stub = freshStub(request.userId, 'clone')
			try {
				return await stub.runIsolatedExternalRefClone(request)
			} catch (error) {
				if (!isResourceLimitReset(error)) throw error
				throw new Error(publishComputeLimitMessage('clone'), { cause: error })
			}
		},
		async discard(stagingKey) {
			await discardStagedPublishWorkFiles({ kv, stagingKey })
		},
	}
}

/**
 * Same interface, run in the calling isolate. Only for envs without the
 * isolate bindings; production always has them.
 */
export function createInlinePublishWorkRunner(input: {
	env: Env
	cloneExternalRefFiles: ExternalRefCloneFiles
	onStep?: (step: RepoCheckStep) => Promise<void>
}): PublishWorkRunner {
	const staged = new Map<string, Record<string, string>>()
	const stage = async (stageInput: {
		userId: OwnerId
		files: Record<string, string>
	}) => {
		const stagingKey = isolatedCheckStagingKeyForUser(stageInput.userId)
		staged.set(stagingKey, stageInput.files)
		return stagingKey
	}
	return {
		isolated: false,
		stage,
		async run(request) {
			const files = staged.get(request.stagingKey)
			if (!files) {
				throw new Error(
					'Publish work staging data expired or is missing; retry the publish.',
				)
			}
			return await runPublishWorkStep({
				env: input.env,
				request,
				files,
				...(input.onStep ? { onStep: input.onStep } : {}),
			})
		},
		async cloneExternalRef(request) {
			await input.onStep?.('clone')
			const cloned = await input.cloneExternalRefFiles(request)
			return {
				stagingKey: await stage({
					userId: request.userId,
					files: cloned.files,
				}),
				headCommit: cloned.headCommit,
				isFastForward: cloned.isFastForward,
				phaseTimings: cloned.phaseTimings,
			}
		},
		async discard(stagingKey) {
			staged.delete(stagingKey)
		},
	}
}

/** {@link PublishHeavyWork} whose every step goes through `runner`. */
export function bindPublishHeavyWork(input: {
	runner: PublishWorkRunner
	stagingKey: string
	userId: OwnerId
}): PublishHeavyWork {
	const { runner, stagingKey, userId } = input
	return {
		runChecks: async (checksInput) =>
			await runner.run({
				op: 'checks',
				stagingKey,
				userId,
				input: checksInput,
			}),
		loadNotices: async (noticesInput) =>
			await runner.run({
				op: 'notices',
				stagingKey,
				userId,
				input: noticesInput,
			}),
		requireApproval: async (approvalInput) =>
			await runner.run({
				op: 'approval',
				stagingKey,
				userId,
				input: approvalInput,
			}),
		writeSnapshot: async (snapshotInput) =>
			await runner.run({
				op: 'write-snapshot',
				stagingKey,
				userId,
				input: snapshotInput,
			}),
		storeCredentialNeeds: async (needsInput) => {
			await runner.run({
				op: 'store-credential-needs',
				stagingKey,
				userId,
				input: needsInput,
			})
		},
		storeCredentialStamp: async (stampInput) =>
			await runner.run({
				op: 'store-credential-stamp',
				stagingKey,
				userId,
				input: stampInput,
			}),
		refreshProjection: async (projectionInput) => {
			await runner.run({
				op: 'refresh-projection',
				stagingKey,
				userId,
				input: projectionInput,
			})
		},
		refreshAlreadyPublishedSnapshot: async (refreshInput) =>
			await runner.run({
				op: 'refresh-already-published-snapshot',
				stagingKey,
				userId,
				input: refreshInput,
			}),
	}
}
