import type { IsomorphicGit } from '#worker/isomorphic-git-load.ts'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import { runArtifactsGitWithRetry } from './artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'

export type CommitAncestryResult = {
	ancestor: string
	descendant: string
	/**
	 * `unknown_commit`: one or both SHAs are not in the repository.
	 * `repo_unavailable`: the repository could not be read.
	 */
	result: 'ancestor' | 'not_ancestor' | 'unknown_commit' | 'repo_unavailable'
	isAncestor: boolean | null
	unknownCommits: Array<string>
}

type EphemeralGitWorkspace = ReturnType<typeof createEphemeralGitWorkspace>

/** A commit is its own ancestor, matching `git merge-base --is-ancestor`. */
export async function checkCommitAncestryInWorkspace(input: {
	git: IsomorphicGit['git']
	workspace: EphemeralGitWorkspace
	ancestor: string
	descendant: string
}): Promise<CommitAncestryResult> {
	const ancestor = input.ancestor.toLowerCase()
	const descendant = input.descendant.toLowerCase()
	const unknownCommits: Array<string> = []
	for (const oid of new Set([ancestor, descendant])) {
		try {
			await input.git.readCommit({
				fs: input.workspace.fs,
				dir: input.workspace.dir,
				oid,
			})
		} catch {
			unknownCommits.push(oid)
		}
	}
	if (unknownCommits.length > 0) {
		return {
			ancestor,
			descendant,
			result: 'unknown_commit',
			isAncestor: null,
			unknownCommits,
		}
	}
	const isAncestor =
		ancestor === descendant ||
		(await input.git.isDescendent({
			fs: input.workspace.fs,
			dir: input.workspace.dir,
			oid: descendant,
			ancestor,
		}))
	return {
		ancestor,
		descendant,
		result: isAncestor ? 'ancestor' : 'not_ancestor',
		isAncestor,
		unknownCommits: [],
	}
}

/**
 * Platform-side ancestry check in a package source's Artifacts repo. The
 * short-lived read token stays inside this function: it is never returned,
 * and fetch failures collapse to `repo_unavailable` so a message that could
 * carry the authenticated remote URL never leaves.
 */
export async function checkSourceRepoCommitAncestry(input: {
	env: Env
	repoId: string
	ancestor: string
	descendant: string
}): Promise<CommitAncestryResult> {
	const unavailable: CommitAncestryResult = {
		ancestor: input.ancestor.toLowerCase(),
		descendant: input.descendant.toLowerCase(),
		result: 'repo_unavailable',
		isAncestor: null,
		unknownCommits: [],
	}
	try {
		const repo = await resolveExistingArtifactSourceRepo(
			input.env,
			input.repoId,
		)
		const info = repo ? await repo.info() : null
		if (!repo || !info?.remote) return unavailable
		const remote = info.remote
		const token = (await repo.createToken('read', 300)).plaintext
		const { git, http } = await loadIsomorphicGit()
		const auth = buildArtifactsGitAuth({ token })
		const workspace = await runArtifactsGitWithRetry(async () => {
			const next = createEphemeralGitWorkspace()
			await git.init({ fs: next.fs, dir: next.dir })
			await git.addRemote({
				fs: next.fs,
				dir: next.dir,
				remote: 'origin',
				url: buildAuthenticatedArtifactsRemote({ remote, token }),
			})
			await git.fetch({
				fs: next.fs,
				http,
				dir: next.dir,
				remote: 'origin',
				singleBranch: false,
				tags: false,
				onAuth: () => auth,
			})
			return next
		})
		return await checkCommitAncestryInWorkspace({
			git,
			workspace,
			ancestor: input.ancestor,
			descendant: input.descendant,
		})
	} catch {
		return unavailable
	}
}
