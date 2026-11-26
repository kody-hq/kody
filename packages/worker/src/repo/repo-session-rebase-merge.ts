import type { IsomorphicGit } from '#worker/isomorphic-git-load.ts'
import { toRepoSessionRebaseCallerError } from './repo-session-caller-error.ts'

type Git = IsomorphicGit['git']

/**
 * Merge a fetched source commit into the session branch and update the
 * working tree. The branch ref moves only after checkout succeeds, so a merge
 * or checkout conflict leaves HEAD, index, and working tree untouched.
 * Conflicts surface as caller errors that name the files.
 */
export async function mergeSourceIntoSessionBranch(input: {
	git: Pick<Git, 'merge' | 'checkout' | 'writeRef'>
	fs: Parameters<Git['merge']>[0]['fs']
	dir: string
	sessionBranch: string
	sourceBranch: string
	sourceCommit: string
	author: { name: string; email: string }
}) {
	const { git, fs, dir } = input
	const mergeArgs = {
		fs,
		dir,
		ours: input.sessionBranch,
		theirs: input.sourceCommit,
		noUpdateBranch: true,
		message: `Merge branch '${input.sourceBranch}' into ${input.sessionBranch}`,
		author: input.author,
	}
	try {
		// isomorphic-git decodes blobs changed on both sides as UTF-8 and
		// text-merges them, which corrupts binary bytes. A dry run first reports
		// those files as conflicts instead.
		await git.merge({
			...mergeArgs,
			dryRun: true,
			mergeDriver: ({ contents }) => ({
				cleanMerge: !contents.some((text) => text.includes('\uFFFD')),
				mergedText: contents[1] ?? '',
			}),
		})
		const merge = await git.merge(mergeArgs)
		if (!merge.oid) {
			throw new Error(
				`Merging "${input.sourceBranch}" into "${input.sessionBranch}" returned no commit.`,
			)
		}
		if (merge.alreadyMerged) return merge.oid
		await git.checkout({ fs, dir, ref: merge.oid, noUpdateHead: true })
		await git.writeRef({
			fs,
			dir,
			ref: `refs/heads/${input.sessionBranch}`,
			value: merge.oid,
			force: true,
		})
		return merge.oid
	} catch (error) {
		throw toRepoSessionRebaseCallerError(error) ?? error
	}
}
