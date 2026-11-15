import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	isSnapshotOnlyArtifactsRemote,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import { readArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import {
	isIsomorphicGitPackfileCorruptionError,
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import {
	bytesToSnapshotString,
	snapshotStringToBytes,
} from '#universal/package-file-media.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'

export async function readArtifactFileAtCommit(input: {
	env: Env
	repoId: string
	commit: string
	filePath: string
}): Promise<Uint8Array | null> {
	const found = await readFirstArtifactFileAtCommit({
		env: input.env,
		repoId: input.repoId,
		commit: input.commit,
		filePaths: [input.filePath],
	})
	return found?.bytes ?? null
}

/**
 * Reads the first candidate path that exists at the given commit using a
 * single shallow fetch, so callers probing a small set of well-known paths
 * (for example `community-icon.*`) do not pay one fetch per candidate.
 */
export async function readFirstArtifactFileAtCommit(input: {
	env: Env
	repoId: string
	commit: string
	filePaths: ReadonlyArray<string>
}): Promise<{ path: string; bytes: Uint8Array } | null> {
	const repo = await resolveExistingArtifactSourceRepo(input.env, input.repoId)
	if (!repo) {
		throw new Error(`Artifact repo "${input.repoId}" was not found.`)
	}
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}

	if (isSnapshotOnlyArtifactsRemote(input.env, info.remote)) {
		const snapshot = await readArtifactSourceSnapshot({
			env: input.env,
			repoId: input.repoId,
			commit: input.commit,
		})
		for (const filePath of input.filePaths) {
			const content = snapshot?.files[filePath]
			if (content != null) {
				return {
					path: filePath,
					bytes: snapshotStringToBytes(content, filePath),
				}
			}
		}
		return null
	}

	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	const { git, http } = await loadIsomorphicGit()
	// isomorphic-git verifies pack checksums on first readObjectPacked (during
	// readBlob), not during fetch — so fetch+read must share one retry scope.
	// Fresh ephemeral workspace per attempt: a corrupt pack may leave partial
	// objects that would poison a retry on the same Map store.
	// (KODY-CLOUDFLARE-56: #1475 retried fetch only; corruption still escaped.)
	try {
		return await runArtifactsGitWithRetry(async () => {
			const workspace = createEphemeralGitWorkspace()
			await git.init({
				fs: workspace.fs,
				dir: workspace.dir,
			})
			await git.addRemote({
				fs: workspace.fs,
				dir: workspace.dir,
				remote: 'origin',
				url: remote,
			})
			await git.fetch({
				fs: workspace.fs,
				http,
				dir: workspace.dir,
				remote: 'origin',
				ref: input.commit,
				depth: 1,
				singleBranch: true,
				tags: false,
				onAuth() {
					return auth
				},
			})

			for (const filePath of input.filePaths) {
				try {
					const result = await git.readBlob({
						fs: workspace.fs,
						dir: workspace.dir,
						oid: input.commit,
						filepath: filePath,
					})
					return { path: filePath, bytes: result.blob }
				} catch (error) {
					// Pack corruption → bubble so runArtifactsGitWithRetry re-fetches.
					if (isIsomorphicGitPackfileCorruptionError(error)) throw error
					if (!isMissingArtifactFileError(error)) throw error
				}
			}
			return null
		})
	} catch (error) {
		throw wrapArtifactsGitHttpError({
			operation: 'git fetch',
			remote: info.remote,
			error,
		})
	}
}

/**
 * Whole-tree read of one Artifacts commit. Production has no KV snapshot for
 * unpublished HEAD, so approve-publish uses this shallow fetch + walk.
 */
export async function readArtifactTreeAtCommit(input: {
	env: Env
	repoId: string
	commit: string
}): Promise<Record<string, string> | null> {
	const repo = await resolveExistingArtifactSourceRepo(input.env, input.repoId)
	if (!repo) {
		throw new Error(`Artifact repo "${input.repoId}" was not found.`)
	}
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}

	if (isSnapshotOnlyArtifactsRemote(input.env, info.remote)) {
		const snapshot = await readArtifactSourceSnapshot({
			env: input.env,
			repoId: input.repoId,
			commit: input.commit,
		})
		return snapshot?.files ?? null
	}

	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	const { git, http } = await loadIsomorphicGit()
	try {
		return await runArtifactsGitWithRetry(async () => {
			const workspace = createEphemeralGitWorkspace()
			await git.init({
				fs: workspace.fs,
				dir: workspace.dir,
			})
			await git.addRemote({
				fs: workspace.fs,
				dir: workspace.dir,
				remote: 'origin',
				url: remote,
			})
			await git.fetch({
				fs: workspace.fs,
				http,
				dir: workspace.dir,
				remote: 'origin',
				ref: input.commit,
				depth: 1,
				singleBranch: true,
				tags: false,
				onAuth() {
					return auth
				},
			})
			const files = Object.create(null) as Record<string, string>
			await git.walk({
				fs: workspace.fs,
				dir: workspace.dir,
				trees: [git.TREE({ ref: input.commit })],
				map: async (filepath, [entry]) => {
					if (!entry || filepath === '.') return
					if ((await entry.type()) !== 'blob') return
					const content = await entry.content()
					if (content == null) return
					files[filepath] = decodeArtifactBlob(content, filepath)
				},
			})
			return files
		})
	} catch (error) {
		throw wrapArtifactsGitHttpError({
			operation: 'git fetch',
			remote: info.remote,
			error,
		})
	}
}

function decodeArtifactBlob(content: Uint8Array | string, filePath: string) {
	if (typeof content === 'string') return content
	// Null-byte blobs and allowlisted media/binaries stay byte-for-byte
	// (latin1) so a later `/raw/` preview can recover the original bytes.
	// The publish diff still skips a text patch when the decoded string
	// includes `\0`.
	return bytesToSnapshotString(content, filePath)
}

function isMissingArtifactFileError(error: unknown) {
	if (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		['NotFoundError', 'ResolveTreeError'].includes(error.code)
	) {
		return true
	}
	return (
		error instanceof Error &&
		/(could not find|not found|no such file|resolve.*tree)/i.test(error.message)
	)
}
