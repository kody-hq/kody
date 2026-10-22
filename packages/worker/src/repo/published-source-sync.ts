import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { snapshotStringToBytes } from '#universal/package-file-media.ts'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	hasArtifactsAccess,
	isLoopbackArtifactsRemote,
	resolveArtifactSourceRepo,
} from './artifacts.ts'
import { writeArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import {
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { finalizePublishedEntitySource } from './external-publish.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'
import {
	attachPublishGitNoteBestEffort,
	buildPublishGitNote,
} from './publish-git-notes.ts'
/**
 * Durable non-default ref that keeps published-only codemod commits fetchable
 * without moving the Artifacts default-branch tip (owner unpublished work).
 * Prior published OIDs stay ancestors when this tip advances by fast-forward.
 */
export const kodyPublishedBranchName = 'kody-published'
export const kodyPublishedRef = `refs/heads/${kodyPublishedBranchName}`

const publishedOnlyCommitAuthor = {
	name: 'Kody Package Codemod',
	email: 'package-codemod@local.invalid',
}

export type SyncPublishedSourceOnlyInput = {
	env: Env
	userId: OwnerId
	baseUrl: string
	sourceId: string
	files: Record<string, string>
	/** Git commit message for the published-only commit. */
	commitMessage: string
	/**
	 * Published commit the caller transformed. Refuse if
	 * `entity_sources.published_commit` moved (owner published concurrently).
	 */
	expectedPublishedCommit: string
	/** Website or platform-owned rewrites may promote a locked package. */
	allowLockedPublish?: boolean
	/**
	 * When false, push the durable ref but do not advance published_commit.
	 * Published-only fleet apply always promotes (including locked packages
	 * via {@link allowLockedPublish}) so migrations never leave a pending tip.
	 * Kept for callers that intentionally stage without promoting.
	 */
	promotePublished?: boolean
}

function canSyncPublishedSource(env: Env) {
	const runtimeEnv = env as Env & {
		APP_DB?: D1Database | undefined
		BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined
	}
	return (
		hasArtifactsAccess(env) &&
		typeof runtimeEnv.APP_DB?.prepare === 'function' &&
		runtimeEnv.BUNDLE_ARTIFACTS_KV != null
	)
}

async function ensureWriteAccess(input: {
	env: Env
	repoId: string
}): Promise<{ remote: string; token: string }> {
	const repo = await resolveArtifactSourceRepo(input.env, input.repoId)
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	const token = await repo.createToken('write', 3600)
	if (typeof token.plaintext !== 'string' || token.plaintext.length === 0) {
		throw new Error('Artifacts createToken result is missing plaintext.')
	}
	return { remote: info.remote, token: token.plaintext }
}

async function materializePublishedCommitWorkspace(input: {
	remote: string
	token: string
	publishedCommit: string
}) {
	const auth = buildArtifactsGitAuth({ token: input.token })
	const authenticatedRemote = buildAuthenticatedArtifactsRemote({
		remote: input.remote,
		token: input.token,
	})
	const { git, http } = await loadIsomorphicGit()
	const onAuth = () => auth

	const workspace = await runArtifactsGitWithRetry(async () => {
		const next = createEphemeralGitWorkspace()
		await git.init({
			fs: next.fs,
			dir: next.dir,
		})
		await git.addRemote({
			fs: next.fs,
			dir: next.dir,
			remote: 'origin',
			url: authenticatedRemote,
		})
		// Prefer the durable published tip (keeps prior published-only OIDs
		// fetchable after default-branch drift). Fall back to fetching the
		// published commit OID directly when the ref does not exist yet.
		try {
			await git.fetch({
				fs: next.fs,
				http,
				dir: next.dir,
				remote: 'origin',
				ref: kodyPublishedRef,
				singleBranch: true,
				tags: false,
				onAuth,
			})
		} catch {
			// First published-only write: ref may not exist yet.
		}
		try {
			await git.fetch({
				fs: next.fs,
				http,
				dir: next.dir,
				remote: 'origin',
				ref: input.publishedCommit,
				depth: 1,
				singleBranch: true,
				tags: false,
				onAuth,
			})
		} catch (error) {
			throw wrapArtifactsGitHttpError({
				operation: 'git fetch',
				remote: input.remote,
				error,
			})
		}
		try {
			// Point a local branch at the OID before checkout. Some Artifacts
			// fetches leave the commit reachable as an object without a named
			// ref; checkout-by-OID alone then fails looking up `.git/refs`.
			await git.branch({
				fs: next.fs,
				dir: next.dir,
				ref: 'kody-published-checkout',
				object: input.publishedCommit,
				force: true,
			})
			await git.checkout({
				fs: next.fs,
				dir: next.dir,
				ref: 'kody-published-checkout',
				force: true,
			})
		} catch (error) {
			throw new Error(
				`Published commit checkout failed for "${input.publishedCommit}": ${getErrorMessage(error)}`,
				{ cause: error },
			)
		}
		return next
	})

	return { git, http, workspace, onAuth, authenticatedRemote }
}

export async function syncWorkspaceFiles(input: {
	git: Awaited<ReturnType<typeof loadIsomorphicGit>>['git']
	filesystem: ReturnType<typeof createEphemeralGitWorkspace>['filesystem']
	fs: ReturnType<typeof createEphemeralGitWorkspace>['fs']
	dir: string
	files: Record<string, string>
}) {
	const existing = await input.git.listFiles({
		fs: input.fs,
		dir: input.dir,
	})
	const nextPaths = new Set(Object.keys(input.files))
	for (const relative of existing) {
		if (relative.split('/').includes('.git')) continue
		if (nextPaths.has(relative)) continue
		const absolute = `${input.dir}/${relative}`.replace(/\/+/g, '/')
		await input.filesystem.rm(absolute)
		await input.git.remove({
			fs: input.fs,
			dir: input.dir,
			filepath: relative,
		})
	}
	for (const [relative, content] of Object.entries(input.files)) {
		const absolute = `${input.dir}/${relative}`.replace(/\/+/g, '/')
		const parent = absolute.slice(0, absolute.lastIndexOf('/'))
		if (parent && parent !== input.dir) {
			await input.filesystem.mkdir(parent, { recursive: true })
		}
		await input.filesystem.writeFileBytes(
			absolute,
			snapshotStringToBytes(content, relative),
		)
	}
	await input.git.add({
		fs: input.fs,
		dir: input.dir,
		filepath: '.',
	})
}

async function commitPublishedOnlyTree(input: {
	git: Awaited<ReturnType<typeof loadIsomorphicGit>>['git']
	fs: ReturnType<typeof createEphemeralGitWorkspace>['fs']
	dir: string
	message: string
	parentCommit: string
}): Promise<string> {
	const statusEntries = await input.git.statusMatrix({
		fs: input.fs,
		dir: input.dir,
	})
	const hasChanges = statusEntries.some(
		([, headStatus, workdirStatus, stageStatus]) =>
			!(headStatus === 1 && workdirStatus === 1 && stageStatus === 1),
	)
	if (!hasChanges) {
		return input.parentCommit
	}
	return await input.git.commit({
		fs: input.fs,
		dir: input.dir,
		message: input.message,
		author: publishedOnlyCommitAuthor,
		committer: publishedOnlyCommitAuthor,
	})
}

async function resolveRemoteKodyPublishedTip(input: {
	git: Awaited<ReturnType<typeof loadIsomorphicGit>>['git']
	http: Awaited<ReturnType<typeof loadIsomorphicGit>>['http']
	fs: ReturnType<typeof createEphemeralGitWorkspace>['fs']
	dir: string
	onAuth: () => { username: string; password: string }
}): Promise<string | null> {
	try {
		await input.git.fetch({
			fs: input.fs,
			http: input.http,
			dir: input.dir,
			remote: 'origin',
			ref: kodyPublishedRef,
			singleBranch: true,
			tags: false,
			onAuth: input.onAuth,
		})
	} catch {
		return null
	}
	try {
		return await input.git.resolveRef({
			fs: input.fs,
			dir: input.dir,
			ref: `refs/remotes/origin/${kodyPublishedBranchName}`,
		})
	} catch {
		try {
			return await input.git.resolveRef({
				fs: input.fs,
				dir: input.dir,
				ref: kodyPublishedRef,
			})
		} catch {
			return null
		}
	}
}

async function pushKodyPublishedRef(input: {
	git: Awaited<ReturnType<typeof loadIsomorphicGit>>['git']
	http: Awaited<ReturnType<typeof loadIsomorphicGit>>['http']
	fs: ReturnType<typeof createEphemeralGitWorkspace>['fs']
	dir: string
	remote: string
	token: string
	commitOid: string
	expectedPublishedCommit: string
	/**
	 * Re-read durable published_commit on non-fast-forward. When it still
	 * matches expected, force-updating recovers leftover tips after a push that
	 * never finalized. When it moved, a concurrent winner already finalized.
	 */
	readPublishedCommit: () => Promise<string | null>
	onAuth: () => { username: string; password: string }
}) {
	// Point a local branch at the new commit, then push only that ref so the
	// default-branch tip (owner unpublished work) is never updated.
	await input.git.branch({
		fs: input.fs,
		dir: input.dir,
		ref: kodyPublishedBranchName,
		object: input.commitOid,
		force: true,
	})
	try {
		await input.git.push({
			fs: input.fs,
			http: input.http,
			dir: input.dir,
			remote: 'origin',
			ref: kodyPublishedBranchName,
			remoteRef: kodyPublishedRef,
			onAuth: input.onAuth,
		})
		return
	} catch (error) {
		const remoteTip = await resolveRemoteKodyPublishedTip({
			git: input.git,
			http: input.http,
			fs: input.fs,
			dir: input.dir,
			onAuth: input.onAuth,
		})
		if (remoteTip == null) {
			throw new Error(
				`Artifacts git push failed for ${input.remote} (${kodyPublishedRef}): ${getErrorMessage(error)}`,
				{ cause: error },
			)
		}
		// TOCTOU: a concurrent apply may have pushed + finalized since the
		// caller's expectedPublishedCommit check. Re-read before force.
		const livePublishedCommit = await input.readPublishedCommit()
		if (livePublishedCommit !== input.expectedPublishedCommit) {
			throw new Error(
				`Artifacts git push non-fast-forward for ${input.remote} (${kodyPublishedRef}): concurrent published-only update (published_commit moved from ${input.expectedPublishedCommit} to ${livePublishedCommit ?? 'null'}; remote tip ${remoteTip}).`,
				{ cause: error },
			)
		}
		// published_commit still at expected: remote tip is a leftover after a
		// push that never finalized, a mid-flight sibling, or a stale tip from
		// a prior published era. Force so retries can recover.
		try {
			await input.git.push({
				fs: input.fs,
				http: input.http,
				dir: input.dir,
				remote: 'origin',
				ref: kodyPublishedBranchName,
				remoteRef: kodyPublishedRef,
				force: true,
				onAuth: input.onAuth,
			})
		} catch (forceError) {
			throw new Error(
				`Artifacts git push failed for ${input.remote} (${kodyPublishedRef}): ${getErrorMessage(forceError instanceof Error ? forceError : error)}`,
				{ cause: forceError instanceof Error ? forceError : error },
			)
		}
	}
}

/**
 * Commit `files` as a child of the current `published_commit`, push that
 * commit to {@link kodyPublishedRef} (never the default branch), and optionally
 * advance `published_commit` + KV via {@link finalizePublishedEntitySource}.
 *
 * Used by fleet codemods with `applyMode: 'published-only'` when Artifacts
 * HEAD has drifted from the published snapshot.
 */
export async function syncPublishedSourceSnapshotOnly(
	input: SyncPublishedSourceOnlyInput,
): Promise<string | null> {
	if (!input.sourceId || !canSyncPublishedSource(input.env)) {
		return null
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source) return null
	if (source.user_id !== input.userId) {
		throw new Error(
			'Entity source ownership mismatch: refusing to sync a published-only snapshot for another user.',
		)
	}
	const publishedCommit = source.published_commit
	if (publishedCommit == null) {
		throw new Error(
			`Source "${source.id}" has no published commit; published-only sync requires an existing published snapshot.`,
		)
	}
	if (publishedCommit !== input.expectedPublishedCommit) {
		throw new Error(
			`Published commit moved for source "${source.id}" (expected ${input.expectedPublishedCommit}, found ${publishedCommit}). Refusing published-only sync so a concurrent owner publish is not overwritten.`,
		)
	}
	if (source.entity_kind !== 'package') {
		throw new Error(
			`Published-only sync is only supported for packages (got "${source.entity_kind}").`,
		)
	}

	const access = await ensureWriteAccess({
		env: input.env,
		repoId: source.repo_id,
	})

	if (isLoopbackArtifactsRemote(access.remote)) {
		const snapshot = await writeArtifactSourceSnapshot({
			env: input.env,
			repoId: source.repo_id,
			files: input.files,
		})
		if (input.promotePublished === false) {
			return snapshot.published_commit
		}
		await finalizePublishedEntitySource({
			env: input.env,
			source,
			publishedCommit: snapshot.published_commit,
			files: input.files,
			baseUrl: input.baseUrl,
			allowLockedPublish: input.allowLockedPublish,
		})
		return snapshot.published_commit
	}

	const { git, http, workspace, onAuth } =
		await materializePublishedCommitWorkspace({
			remote: access.remote,
			token: access.token,
			publishedCommit,
		})

	await syncWorkspaceFiles({
		git,
		filesystem: workspace.filesystem,
		fs: workspace.fs,
		dir: workspace.dir,
		files: input.files,
	})

	const newCommit = await commitPublishedOnlyTree({
		git,
		fs: workspace.fs,
		dir: workspace.dir,
		message: input.commitMessage,
		parentCommit: publishedCommit,
	})

	if (newCommit !== publishedCommit) {
		await pushKodyPublishedRef({
			git,
			http,
			fs: workspace.fs,
			dir: workspace.dir,
			remote: access.remote,
			token: access.token,
			commitOid: newCommit,
			expectedPublishedCommit: input.expectedPublishedCommit,
			readPublishedCommit: async () => {
				const latest = await getEntitySourceById(
					input.env.APP_DB,
					input.sourceId,
				)
				return latest?.published_commit ?? null
			},
			onAuth,
		})
	}

	if (input.promotePublished === false) {
		return newCommit
	}

	await finalizePublishedEntitySource({
		env: input.env,
		source,
		publishedCommit: newCommit,
		files: input.files,
		baseUrl: input.baseUrl,
		allowLockedPublish: input.allowLockedPublish,
	})

	await attachPublishGitNoteBestEffort({
		filesystem: workspace.filesystem,
		dir: workspace.dir,
		commitOid: newCommit,
		remote: access.remote,
		token: access.token,
		remoteName: 'origin',
		note: buildPublishGitNote({
			publishedBy: 'external_push',
			source: {
				id: source.id,
				entity_kind: source.entity_kind,
				entity_id: source.entity_id,
				repo_id: source.repo_id,
				published_commit: publishedCommit,
			},
			commit: newCommit,
			previousPublishedCommit: publishedCommit,
			baseCommit: publishedCommit,
		}),
		scope: 'repo.syncPublishedSourceSnapshotOnly.publish-git-note',
	})

	return newCommit
}
