import rawGit from 'isomorphic-git'
import { expect, test, vi } from 'vitest'
import type { IsomorphicGit } from '#worker/isomorphic-git-load.ts'
import {
	checkCommitAncestryInWorkspace,
	checkSourceRepoCommitAncestry,
} from './commit-ancestry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'

const mocks = vi.hoisted(() => ({
	resolveExistingArtifactSourceRepo: vi.fn(),
	loadIsomorphicGit: vi.fn(),
}))

vi.mock('./artifacts.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveExistingArtifactSourceRepo: mocks.resolveExistingArtifactSourceRepo,
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: mocks.loadIsomorphicGit,
}))

vi.mock('./artifacts-git-retry.ts', () => ({
	runArtifactsGitWithRetry: (operation: () => Promise<unknown>) => operation(),
}))

type RawGitFs = Parameters<typeof rawGit.init>[0]['fs']
const git = rawGit as unknown as IsomorphicGit['git']

async function commitFile(
	workspace: ReturnType<typeof createEphemeralGitWorkspace>,
	contents: string,
	ref = 'main',
) {
	const fs = workspace.fs as RawGitFs
	await workspace.fs.promises.writeFile(
		`${workspace.dir}/file.txt`,
		new TextEncoder().encode(contents),
	)
	await rawGit.add({ fs, dir: workspace.dir, filepath: 'file.txt' })
	return await rawGit.commit({
		fs,
		dir: workspace.dir,
		ref: `refs/heads/${ref}`,
		message: contents,
		author: { name: 'Kody Test', email: 'test@local.invalid' },
	})
}

async function createHistory() {
	const workspace = createEphemeralGitWorkspace()
	const fs = workspace.fs as RawGitFs
	await rawGit.init({ fs, dir: workspace.dir, defaultBranch: 'main' })
	const root = await commitFile(workspace, 'root')
	const head = await commitFile(workspace, 'head')
	await rawGit.branch({ fs, dir: workspace.dir, ref: 'side', object: root })
	await rawGit.checkout({ fs, dir: workspace.dir, ref: 'side' })
	const side = await commitFile(workspace, 'side', 'side')
	return { workspace, root, head, side }
}

test('commit ancestry reports ancestor, not ancestor, and unknown commits', async () => {
	const { workspace, root, head, side } = await createHistory()

	expect(
		await checkCommitAncestryInWorkspace({
			git,
			workspace,
			ancestor: root,
			descendant: head,
		}),
	).toEqual({
		ancestor: root,
		descendant: head,
		result: 'ancestor',
		isAncestor: true,
		unknownCommits: [],
	})
	expect(
		await checkCommitAncestryInWorkspace({
			git,
			workspace,
			ancestor: head,
			descendant: head.toUpperCase(),
		}),
	).toMatchObject({ result: 'ancestor', isAncestor: true })

	expect(
		await checkCommitAncestryInWorkspace({
			git,
			workspace,
			ancestor: head,
			descendant: root,
		}),
	).toMatchObject({ result: 'not_ancestor', isAncestor: false })
	expect(
		await checkCommitAncestryInWorkspace({
			git,
			workspace,
			ancestor: side,
			descendant: head,
		}),
	).toMatchObject({ result: 'not_ancestor', isAncestor: false })

	const missing = 'f'.repeat(40)
	expect(
		await checkCommitAncestryInWorkspace({
			git,
			workspace,
			ancestor: missing,
			descendant: head,
		}),
	).toEqual({
		ancestor: missing,
		descendant: head,
		result: 'unknown_commit',
		isAncestor: null,
		unknownCommits: [missing],
	})
})

test('source repo ancestry never surfaces the repo token when the fetch fails', async () => {
	const token = 'art_v1_provenance-test-token?expires=1999999999'
	const createToken = vi.fn(async () => ({ plaintext: token }))
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote: 'https://artifacts.example.test/repo.git',
			defaultBranch: 'main',
		}),
		createToken,
	})
	mocks.loadIsomorphicGit.mockResolvedValue({
		git: {
			init: async () => {},
			addRemote: async (input: { url: string }) => {
				expect(input.url).toContain('provenance-test-token')
			},
			fetch: async () => {
				throw new Error(
					`fetch failed for https://x:${token}@artifacts.example.test/repo.git`,
				)
			},
		},
		http: {},
	})

	const result = await checkSourceRepoCommitAncestry({
		env: {} as Env,
		repoId: 'repo-1',
		ancestor: 'a'.repeat(40),
		descendant: 'b'.repeat(40),
	})

	expect(createToken).toHaveBeenCalledWith('read', 300)
	expect(result).toEqual({
		ancestor: 'a'.repeat(40),
		descendant: 'b'.repeat(40),
		result: 'repo_unavailable',
		isAncestor: null,
		unknownCommits: [],
	})
	expect(JSON.stringify(result)).not.toContain('provenance-test-token')

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(null)
	expect(
		await checkSourceRepoCommitAncestry({
			env: {} as Env,
			repoId: 'repo-missing',
			ancestor: 'a'.repeat(40),
			descendant: 'b'.repeat(40),
		}),
	).toMatchObject({ result: 'repo_unavailable' })
})
