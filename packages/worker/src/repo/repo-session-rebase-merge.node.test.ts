import rawGit from 'isomorphic-git'
import { expect, test } from 'vitest'
import type { IsomorphicGit } from '#worker/isomorphic-git-load.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import { isRepoSessionRebaseStoppedMessage } from './repo-session-caller-error.ts'
import { mergeSourceIntoSessionBranch } from './repo-session-rebase-merge.ts'

type RawGitFs = Parameters<typeof rawGit.init>[0]['fs']
const git = rawGit as unknown as IsomorphicGit['git']
const author = { name: 'Kody Test', email: 'test@local.invalid' }
const path = 'src/client/index.ts'
const base = 'export const a = 1\n\n\n\nexport const b = 1\n'

async function createSessionRepo() {
	const workspace = createEphemeralGitWorkspace()
	const fs = workspace.fs as RawGitFs
	const dir = workspace.dir
	const write = (contents: string) =>
		workspace.fs.promises.writeFile(
			`${dir}/${path}`,
			new TextEncoder().encode(contents),
		)
	const read = async () =>
		new TextDecoder().decode(
			(await workspace.fs.promises.readFile(`${dir}/${path}`)) as Uint8Array,
		)
	const commit = async (message: string, ref: string) => {
		await rawGit.add({ fs, dir, filepath: path })
		return rawGit.commit({ fs, dir, ref, message, author })
	}
	await rawGit.init({ fs, dir, defaultBranch: 'main' })
	await workspace.fs.promises.mkdir(`${dir}/src`)
	await workspace.fs.promises.mkdir(`${dir}/src/client`)
	await write(base)
	await commit('base', 'refs/heads/main')
	await rawGit.branch({ fs, dir, ref: 'sessions/s1', checkout: true })
	// The source moves on `main` while the session works on its branch.
	await write(base.replace('a = 1', 'a = 2'))
	const sourceCommit = await commit('source moved', 'refs/heads/main')
	await rawGit.checkout({ fs, dir, ref: 'sessions/s1', force: true })
	return { fs, dir, write, read, commit, sourceCommit }
}

function merge(repo: Awaited<ReturnType<typeof createSessionRepo>>) {
	return mergeSourceIntoSessionBranch({
		git,
		fs: repo.fs,
		dir: repo.dir,
		sessionBranch: 'sessions/s1',
		sourceBranch: 'main',
		sourceCommit: repo.sourceCommit,
		author,
	})
}

test('session edits to a file the source also changed merge onto the new base', async () => {
	const repo = await createSessionRepo()
	await repo.write(base.replace('b = 1', 'b = 2'))
	await repo.commit('session edit', 'refs/heads/sessions/s1')

	const merged = await merge(repo)

	expect(await repo.read()).toBe(
		'export const a = 2\n\n\n\nexport const b = 2\n',
	)
	await expect(
		rawGit.resolveRef({ fs: repo.fs, dir: repo.dir, ref: 'sessions/s1' }),
	).resolves.toBe(merged)
	const status = await rawGit.statusMatrix({ fs: repo.fs, dir: repo.dir })
	expect(
		status.every(([, head, work, stage]) => head === work && work === stage),
	).toBe(true)
})

test('a clean session fast-forwards to the source commit', async () => {
	const repo = await createSessionRepo()

	await expect(merge(repo)).resolves.toBe(repo.sourceCommit)
	expect(await repo.read()).toBe(base.replace('a = 1', 'a = 2'))
})

test('conflicting session edits throw a caller error and leave the branch and tree alone', async () => {
	const repo = await createSessionRepo()
	await repo.write(base.replace('a = 1', 'a = 3'))
	const sessionHead = await repo.commit(
		'session edit',
		'refs/heads/sessions/s1',
	)

	const error = await merge(repo).then(
		() => null,
		(caught: unknown) => caught as Error,
	)

	expect(isRepoSessionRebaseStoppedMessage(error!.message)).toBe(true)
	expect(error!.message).toContain(path)
	await expect(
		rawGit.resolveRef({ fs: repo.fs, dir: repo.dir, ref: 'sessions/s1' }),
	).resolves.toBe(sessionHead)
	expect(await repo.read()).toBe(base.replace('a = 1', 'a = 3'))
})

test('uncommitted edits the source changed fail checkout without moving the branch', async () => {
	const repo = await createSessionRepo()
	const sessionHead = await rawGit.resolveRef({
		fs: repo.fs,
		dir: repo.dir,
		ref: 'sessions/s1',
	})
	await repo.write(base.replace('b = 1', 'b = 22'))

	const error = await merge(repo).then(
		() => null,
		(caught: unknown) => caught as Error,
	)

	expect(isRepoSessionRebaseStoppedMessage(error!.message)).toBe(true)
	expect(error!.message).toContain(path)
	await expect(
		rawGit.resolveRef({ fs: repo.fs, dir: repo.dir, ref: 'sessions/s1' }),
	).resolves.toBe(sessionHead)
	expect(await repo.read()).toBe(base.replace('b = 1', 'b = 22'))
})
