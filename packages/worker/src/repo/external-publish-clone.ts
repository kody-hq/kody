import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { bytesToSnapshotString } from '#universal/package-file-media.ts'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
} from './artifacts.ts'
import {
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'
import { type RepoPublishWorkspace } from './external-publish.ts'
import { type PublishGitNoteFileSystem } from './publish-git-notes.ts'
import { unknownRequestedCommitError } from './requested-commit-error.ts'

/**
 * Clone / checkout for `packagePublishExternalPush` must not use the
 * RepoSession Durable Object SQL workspace. isomorphic-git writes the whole
 * packfile as one blob. Interactive RepoSession workspaces spill those
 * objects to `REPO_SESSION_BLOBS`. External publish stays on an ephemeral
 * in-memory FS so it never depends on that Durable Object workspace
 * (Artifacts packs are already capped ~32 MiB).
 */
export const externalPublishWorkspaceDir = '/repo'

export type ExternalPublishCloneResult = {
	workspace: RepoPublishWorkspace
	headCommit: string | null
	isAncestorCommit: (input: {
		ancestor: string
		descendant: string
	}) => Promise<boolean>
	filesystem: PublishGitNoteFileSystem
	dir: string
	collectFiles(): Promise<Record<string, string>>
}

function normalizePublishPath(path: string) {
	const trimmed = path.trim()
	if (trimmed === '' || trimmed === '/') return '/'
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

async function collectPublishWorkspaceFiles(input: {
	filesystem: PublishGitNoteFileSystem
	dir: string
	listFiles: () => Promise<Array<string>>
}) {
	const dirPrefix = input.dir.endsWith('/') ? input.dir.slice(0, -1) : input.dir
	const files: Record<string, string> = {}
	for (const relative of await input.listFiles()) {
		if (relative.split('/').includes('.git')) continue
		const absolute = `${dirPrefix}/${relative}`.replace(/\/+/g, '/')
		let bytes: Uint8Array
		try {
			// Raw bytes — UTF-8 `readFile` replaces invalid sequences with
			// U+FFFD (PNG `0x89` → `0xFD`), which then poisons `/_assets`.
			bytes = await input.filesystem.readFileBytes(absolute)
		} catch {
			throw new Error(
				`Failed to read published clone file "${absolute}" while refreshing the source snapshot.`,
			)
		}
		files[relative] = bytesToSnapshotString(bytes, relative)
	}
	return files
}

function buildPublishWorkspaceFromCheckout(input: {
	filesystem: PublishGitNoteFileSystem
	listFiles: () => Promise<Array<string>>
	dir: string
}): RepoPublishWorkspace {
	const dirPrefix = input.dir.endsWith('/') ? input.dir.slice(0, -1) : input.dir
	const dirName = dirPrefix.replace(/^\/+/, '')
	return {
		async readFile(path) {
			const absolute = normalizePublishPath(path)
			try {
				return await input.filesystem.readFile(absolute)
			} catch {
				return null
			}
		},
		async glob(pattern) {
			const files = await input.listFiles()
			// runRepoChecks builds patterns from normalizeRepoWorkspacePath(sourceRoot),
			// so `/repo` (or `/repo/subdir`) becomes `repo/**/*` / `repo/subdir/**/*`.
			// git.listFiles paths are relative to the worktree root — strip the
			// workspace dir segment before filtering or every file is dropped.
			const normalizedPattern = pattern.replace(/^\.\//, '')
			let relativeRoot = ''
			if (
				normalizedPattern === '**/*' ||
				normalizedPattern === '*' ||
				normalizedPattern === ''
			) {
				relativeRoot = ''
			} else if (normalizedPattern.endsWith('/**/*')) {
				relativeRoot = normalizedPattern
					.slice(0, -'/**/*'.length)
					.replace(/^\/+/, '')
			} else {
				relativeRoot = normalizedPattern.replace(/^\/+/, '').replace(/\/+$/, '')
			}
			if (relativeRoot === dirName) {
				relativeRoot = ''
			} else if (relativeRoot.startsWith(`${dirName}/`)) {
				relativeRoot = relativeRoot.slice(dirName.length + 1)
			}
			const entries: Array<{ path: string; type: string }> = []
			for (const relative of files) {
				if (relative.split('/').includes('.git')) continue
				if (
					relativeRoot !== '' &&
					relative !== relativeRoot &&
					!relative.startsWith(`${relativeRoot}/`)
				) {
					continue
				}
				entries.push({
					path: `${dirPrefix}/${relative}`.replace(/\/+/g, '/'),
					type: 'file',
				})
			}
			return entries
		},
	}
}

export async function cloneExternalPublishWorkspace(input: {
	remote: string
	token: string
	branch: string
	checkoutCommit: string
}): Promise<ExternalPublishCloneResult> {
	const auth = buildArtifactsGitAuth({ token: input.token })
	const authenticatedRemote = buildAuthenticatedArtifactsRemote({
		remote: input.remote,
		token: input.token,
	})
	const dir = externalPublishWorkspaceDir
	const { git, http } = await loadIsomorphicGit()

	let workspace: ReturnType<typeof createEphemeralGitWorkspace>
	try {
		workspace = await runArtifactsGitWithRetry(async () => {
			const next = createEphemeralGitWorkspace()
			await git.clone({
				fs: next.fs,
				http,
				dir,
				url: authenticatedRemote,
				ref: input.branch,
				singleBranch: true,
				onAuth() {
					return auth
				},
			})
			return next
		})
	} catch (error) {
		throw wrapArtifactsGitHttpError({
			operation: 'git clone',
			remote: input.remote,
			error,
		})
	}

	let headCommit: string | null = null
	try {
		const log = await git.log({
			fs: workspace.fs,
			dir,
			depth: 1,
		})
		headCommit = log[0]?.oid ?? null
	} catch (error) {
		throw new Error(
			`Failed to resolve cloned HEAD after Artifacts clone: ${getErrorMessage(error)}`,
			{ cause: error },
		)
	}

	try {
		await git.checkout({
			fs: workspace.fs,
			dir,
			ref: input.checkoutCommit,
			force: true,
		})
	} catch (error) {
		// Storage failures stay storage failures. A missing requested commit
		// is not a clone failure and must not be labeled as one.
		if (isWorkspaceSqliteTooBigMessage(getErrorMessage(error))) {
			throw error
		}
		const unknownCommit = unknownRequestedCommitError(
			error,
			input.checkoutCommit,
		)
		if (unknownCommit) throw unknownCommit
		throw new Error(`commit checkout failed: ${getErrorMessage(error)}`, {
			cause: error,
		})
	}

	const listFiles = async () =>
		await git.listFiles({
			fs: workspace.fs,
			dir,
		})
	const publishWorkspace = buildPublishWorkspaceFromCheckout({
		dir,
		filesystem: workspace.filesystem,
		listFiles,
	})

	return {
		workspace: publishWorkspace,
		headCommit,
		dir,
		filesystem: workspace.filesystem,
		collectFiles: async () =>
			await collectPublishWorkspaceFiles({
				filesystem: workspace.filesystem,
				dir,
				listFiles,
			}),
		isAncestorCommit: async ({ ancestor, descendant }) => {
			if (ancestor === descendant) return true
			const commits = await git.log({
				fs: workspace.fs,
				dir,
				ref: descendant,
				depth: Number.POSITIVE_INFINITY,
			})
			return commits.some((commit) => commit.oid === ancestor)
		},
	}
}

/**
 * Stable phrase for DO SQL Workspace writes that exceed Cloudflare's 2 MiB
 * string/BLOB row limit. Interactive sessions spill objects above the
 * Workspace inline threshold to `REPO_SESSION_BLOBS`; this still matches
 * residual inline writes that never reached R2.
 */
export function isWorkspaceSqliteTooBigMessage(message: string) {
	return (
		message.includes('SQLITE_TOOBIG') || /string or blob too big/i.test(message)
	)
}

export function buildWorkspaceSqliteTooBigCallerMessage(operation: string) {
	return (
		`${operation} failed because a git object exceeded the Durable Object ` +
		`SQLite 2 MiB row limit while materializing the repo session workspace ` +
		`(string or blob too big: SQLITE_TOOBIG). Session workspaces spill ` +
		`objects above the inline threshold to REPO_SESSION_BLOBS; this error ` +
		`means the write stayed inline. Shrink the object or retry. ` +
		`packagePublishExternalPush uses an in-memory clone and is not limited ` +
		`by this row ceiling.`
	)
}
