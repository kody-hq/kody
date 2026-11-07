import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	isLoopbackArtifactsRemote,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import {
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'

export type ArtifactCommitSummary = {
	commit: string
	subject: string
	authoredAt: string | null
}

export type ArtifactCommitsAfter = {
	/** Newest first, at most `limit`. */
	commits: Array<ArtifactCommitSummary>
	/** True when more than `limit` commits are newer than `after`. */
	truncated: boolean
}

/**
 * Commits reachable from `head` that are newer than `after` (the published
 * commit), newest first. A null `after` lists from the root. Null when the
 * repo has no git remote to read (local loopback Artifacts).
 */
export async function listArtifactCommitsAfter(input: {
	env: Env
	repoId: string
	head: string
	after: string | null
	limit: number
}): Promise<ArtifactCommitsAfter | null> {
	const repo = await resolveExistingArtifactSourceRepo(input.env, input.repoId)
	if (!repo) return null
	const info = await repo.info()
	if (!info?.remote || isLoopbackArtifactsRemote(info.remote)) return null

	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	const { git, http } = await loadIsomorphicGit()
	const depth = input.limit + 1
	try {
		return await runArtifactsGitWithRetry(async () => {
			const workspace = createEphemeralGitWorkspace()
			await git.init({ fs: workspace.fs, dir: workspace.dir })
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
				ref: input.head,
				depth,
				singleBranch: true,
				tags: false,
				onAuth() {
					return auth
				},
			})
			const log = await git.log({
				fs: workspace.fs,
				dir: workspace.dir,
				ref: input.head,
				depth,
			})
			return commitsAfter(log, input.after, input.limit)
		})
	} catch (error) {
		throw wrapArtifactsGitHttpError({
			operation: 'git fetch',
			remote: info.remote,
			error,
		})
	}
}

export function commitsAfter(
	log: ReadonlyArray<{
		oid: string
		commit: { message: string; author: { timestamp: number } }
	}>,
	after: string | null,
	limit: number,
): ArtifactCommitsAfter {
	const commits: Array<ArtifactCommitSummary> = []
	const stop = after?.toLowerCase() ?? null
	for (const entry of log) {
		if (stop && entry.oid.toLowerCase() === stop) {
			return { commits, truncated: false }
		}
		if (commits.length === limit) return { commits, truncated: true }
		commits.push({
			commit: entry.oid,
			subject: entry.commit.message.split('\n')[0]?.trim() ?? '',
			authoredAt: Number.isFinite(entry.commit.author.timestamp)
				? new Date(entry.commit.author.timestamp * 1000).toISOString()
				: null,
		})
	}
	return { commits, truncated: false }
}
