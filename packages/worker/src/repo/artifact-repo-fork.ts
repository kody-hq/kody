import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	rewriteForkedPackageSelfReferences,
	rewritePackageManifestForFork,
} from '#worker/community/fork-scan.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	readArtifactFileAtCommit,
	readArtifactTreeAtCommit,
} from './artifact-file.ts'
import { writeArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import {
	getArtifactsBinding,
	isArtifactRepoNotFoundError,
	isLoopbackArtifactsRemote,
	resolveArtifactSourceHead,
	resolveExistingArtifactSourceRepo,
	type ArtifactBootstrapAccess,
	type ArtifactCreateRepoResult,
} from './artifacts.ts'
import {
	getArtifactsGitHttpStatus,
	isArtifactsGitMissingObjectError,
	isArtifactsGitTransientRemapError,
	isArtifactsGitWrappedFailureError,
	isIsomorphicGitPackfileCorruptionError,
} from './artifacts-git-retry.ts'
import { updateEntitySource } from './entity-sources.ts'
import { syncArtifactSourceSnapshot } from './source-sync.ts'
import type { EntitySourceRow } from './types.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

export async function forkArtifactRepo(input: {
	env: Env
	sourceRepoId: string
	targetRepoId: string
}): Promise<ArtifactCreateRepoResult> {
	const binding = getArtifactsBinding(input.env)
	return await binding.fork(input.sourceRepoId, input.targetRepoId, {
		readOnly: false,
		defaultBranchOnly: true,
	})
}

export type PersistForkedArtifactRepoResult = {
	copiedOriginCommit: string
	destCommit: string | null
}

/**
 * After a storage-layer Artifacts fork, stamp dest HEAD and rewrite only
 * what is safe against that tip.
 *
 * Loopback remotes (local mock) have no real git object store: the copied
 * mock snapshot is overwritten with the already-rewritten Worker tree so
 * dest contents match production's "fork + small commit" outcome without
 * opening a RepoSession.
 *
 * Production remotes apply the rewrite as a first publish from dest HEAD
 * (the default-branch tip Artifacts copied). They must not stamp
 * `published_commit` before that rewrite: doing so opens the existing-source
 * session path and `publishSession({ force: true })`, which the overwrite
 * gate correctly rejects for a brand-new fork. When dest HEAD matches the
 * listing pin used in prepare, `changedFiles` apply. When dest HEAD is
 * ahead of that pin, only dest HEAD's `package.json` is rewritten so
 * pin-relative edits cannot revert later origin commits.
 */
export async function persistForkedArtifactRepoContents(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	source: EntitySourceRow
	originCommit: string
	expectedPackageScope: string
	targetKodyId: string
	changedFiles: Record<string, string>
	files: Record<string, string>
	bootstrapAccess?: ArtifactBootstrapAccess | null
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PersistForkedArtifactRepoResult> {
	const destRepo = await resolveExistingArtifactSourceRepo(
		input.env,
		input.source.repo_id,
	)
	const info = destRepo ? await destRepo.info() : null
	if (info?.remote && isLoopbackArtifactsRemote(info.remote)) {
		return await pushServerTiming(
			input.serverTiming,
			'fork-loopback-snapshot',
			async () => {
				const snapshot = await writeArtifactSourceSnapshot({
					env: input.env,
					repoId: input.source.repo_id,
					files: input.files,
				})
				await writePublishedSourceSnapshot({
					env: input.env,
					source: {
						...input.source,
						published_commit: snapshot.published_commit,
					},
					files: input.files,
				})
				const marked = await updateEntitySource(input.env.APP_DB, {
					id: input.source.id,
					userId: input.source.user_id,
					publishedCommit: snapshot.published_commit,
				})
				if (!marked) {
					throw new Error(
						`Forked source "${input.source.id}" could not be marked at dest commit ${snapshot.published_commit}.`,
					)
				}
				return {
					copiedOriginCommit: input.originCommit,
					destCommit: snapshot.published_commit,
				}
			},
		)
	}

	const destHead = await resolveArtifactSourceHead(
		input.env,
		input.source.repo_id,
	)
	if (!destHead.commit) {
		throw new Error(
			`Forked artifact repo "${input.source.repo_id}" default branch has no HEAD.`,
		)
	}

	const filesToSync =
		destHead.commit === input.originCommit
			? input.changedFiles
			: await buildDestHeadRewriteFiles({
					env: input.env,
					repoId: input.source.repo_id,
					destHead: destHead.commit,
					expectedPackageScope: input.expectedPackageScope,
					targetKodyId: input.targetKodyId,
				})
	if (Object.keys(filesToSync).length === 0) {
		// No rewrite diff means dest HEAD already has the forked tree, but
		// published_commit must still have a matching KV snapshot. Writing
		// the tip without a snapshot leaves package loads permanently broken
		// in production (#3497).
		const treeFiles = await readArtifactTreeAtCommit({
			env: input.env,
			repoId: input.source.repo_id,
			commit: destHead.commit,
		})
		const files =
			treeFiles ?? (destHead.commit === input.originCommit ? input.files : null)
		if (!files || Object.keys(files).length === 0) {
			throw new Error(
				`Forked source "${input.source.id}" has no rewrite diff at dest HEAD ${destHead.commit}, but the artifact tree could not be read to build a published snapshot.`,
			)
		}
		await writePublishedSourceSnapshot({
			env: input.env,
			source: {
				...input.source,
				published_commit: destHead.commit,
			},
			files,
		})
		const marked = await updateEntitySource(input.env.APP_DB, {
			id: input.source.id,
			userId: input.source.user_id,
			publishedCommit: destHead.commit,
		})
		if (!marked) {
			throw new Error(
				`Forked source "${input.source.id}" could not be marked at dest HEAD ${destHead.commit}.`,
			)
		}
		return {
			copiedOriginCommit: destHead.commit,
			destCommit: destHead.commit,
		}
	}
	const destCommit = await syncArtifactSourceSnapshot({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.source.id,
		files: filesToSync,
		existingHeadCommit: destHead.commit,
		bootstrapAccess: input.bootstrapAccess ?? null,
		serverTiming: input.serverTiming,
		// Same as ordinary community persist: installer checks decide live vs
		// adaptation_required after the fork source is stamped.
		runPublishChecks: false,
	})
	return {
		copiedOriginCommit: destHead.commit,
		destCommit,
	}
}

async function buildDestHeadRewriteFiles(input: {
	env: Env
	repoId: string
	destHead: string
	expectedPackageScope: string
	targetKodyId: string
}): Promise<Record<string, string>> {
	const bytes = await readArtifactFileAtCommit({
		env: input.env,
		repoId: input.repoId,
		commit: input.destHead,
		filePath: 'package.json',
	})
	if (!bytes) {
		throw new Error(
			`Forked artifact repo "${input.repoId}" is missing package.json at ${input.destHead}.`,
		)
	}
	const manifestContent = new TextDecoder().decode(bytes)
	const rewritten = rewritePackageManifestForFork({
		manifestContent,
		expectedPackageScope: input.expectedPackageScope,
		targetKodyId: input.targetKodyId,
	})
	if (rewritten.content === manifestContent) return {}
	return { 'package.json': rewritten.content }
}

export function shouldFallbackFromArtifactFork(error: unknown) {
	return isArtifactRepoNotFoundError(error)
}

/**
 * After a storage-layer Artifacts fork, rewriting dest HEAD opens a RepoSession
 * git clone of the forked dest. Cloudflare sometimes returns persistent HTTP
 * 5xx / corrupt packs for that dest even when the origin remote is healthy
 * (KODY-8P / @kody/discord). Fall back to writing the already-prepared full
 * tree into a fresh empty repo — same outcome as the origin-not-found path.
 */
export function shouldFallbackFromForkedArtifactPersist(error: unknown) {
	if (isArtifactsGitTransientRemapError(error)) return true
	if (isIsomorphicGitPackfileCorruptionError(error)) return true
	if (isArtifactsGitMissingObjectError(error)) return true
	if (!isArtifactsGitWrappedFailureError(error)) return false
	const status = getArtifactsGitHttpStatus(error)
	if (status == null) return true
	if (status === 404 || status === 429) return true
	return status >= 500 && status <= 599
}

/**
 * Build the file tree for a storage-fork → full-tree fallback.
 *
 * Storage fork copies origin HEAD. `preparedFiles` may still be the listing
 * pin when no KV snapshot exists for HEAD. Prefer reading the copied dest HEAD
 * tree from origin before deleting the broken dest; refuse to publish a stale
 * prepared tree when dest HEAD is ahead of the prepared commit, and abort when
 * dest HEAD cannot be resolved.
 */
export async function resolveCommunityForkArtifactsGitFallbackTree(input: {
	env: Env
	destRepoId: string
	originRepoId: string | null
	preparedOriginCommit: string
	preparedFiles: Record<string, string>
	expectedPackageScope: string
	targetKodyId: string
	listingName: string
	targetName: string
}): Promise<{ files: Record<string, string>; originCommit: string } | null> {
	let destHeadCommit: string | null = null
	try {
		const destHead = await resolveArtifactSourceHead(
			input.env,
			input.destRepoId,
		)
		destHeadCommit = destHead.commit
	} catch {
		// Cannot tell whether preparedFiles match the copied dest HEAD. Abort
		// rather than risk publishing a stale listing-pin tree.
		return null
	}

	if (!destHeadCommit || destHeadCommit === input.preparedOriginCommit) {
		return {
			files: input.preparedFiles,
			originCommit: destHeadCommit ?? input.preparedOriginCommit,
		}
	}

	if (!input.originRepoId) return null

	let originTree: Record<string, string> | null = null
	try {
		originTree = await readArtifactTreeAtCommit({
			env: input.env,
			repoId: input.originRepoId,
			commit: destHeadCommit,
		})
	} catch {
		return null
	}
	const packageJson = originTree?.['package.json']
	if (!originTree || typeof packageJson !== 'string') return null

	const rewrittenManifest = rewritePackageManifestForFork({
		manifestContent: packageJson,
		expectedPackageScope: input.expectedPackageScope,
		targetKodyId: input.targetKodyId,
	})
	return {
		originCommit: destHeadCommit,
		files: rewriteForkedPackageSelfReferences({
			files: {
				...originTree,
				'package.json': rewrittenManifest.content,
			},
			originPackageName: input.listingName,
			nextPackageName: input.targetName,
		}),
	}
}
