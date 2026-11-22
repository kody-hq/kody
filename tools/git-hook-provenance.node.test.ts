import { expect, test } from 'vitest'
import { treeShaForWorktree } from './git-hook-provenance.ts'

const stashSha = 'a'.repeat(40)
const stashTree = 'b'.repeat(40)
const headTree = 'c'.repeat(40)

function fakeGit(stash: { status: number; stdout: string }) {
	return (args: ReadonlyArray<string>) => {
		if (args[0] === 'stash') return { ...stash, stderr: '' }
		const ref = args.at(-1)
		if (ref === 'HEAD^{tree}')
			return { status: 0, stdout: headTree, stderr: '' }
		if (ref?.startsWith(stashSha)) {
			return { status: 0, stdout: stashTree, stderr: '' }
		}
		return { status: 1, stdout: '', stderr: '' }
	}
}

test('treeShaForWorktree uses the stash tree, HEAD only for a clean worktree, and null when stash fails', () => {
	expect(
		treeShaForWorktree(fakeGit({ status: 0, stdout: `${stashSha}\n` })),
	).toBe(stashTree)
	expect(treeShaForWorktree(fakeGit({ status: 0, stdout: '' }))).toBe(headTree)
	expect(treeShaForWorktree(fakeGit({ status: 1, stdout: '' }))).toBeNull()
	expect(
		treeShaForWorktree(fakeGit({ status: 0, stdout: 'garbage' })),
	).toBeNull()
})
