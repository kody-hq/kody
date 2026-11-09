import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import {
	hasRepoToken,
	parseMockGitPath,
	startMockArtifactsGitServer,
} from './mock-artifacts-git-server.ts'

test('parses repo paths and refuses traversal', () => {
	expect(parseMockGitPath('/git/production/repo-1.git/info/refs')).toEqual({
		namespace: 'production',
		repo: 'repo-1.git',
		rest: '/info/refs',
	})
	expect(parseMockGitPath('/git/../x.git/info/refs')).toBeNull()
	expect(parseMockGitPath('/git/production/..git/info/refs')).toBeNull()
	expect(parseMockGitPath('/client/v4/accounts')).toBeNull()
	expect(hasRepoToken(`Basic ${btoa('x:token')}`)).toBe(true)
	expect(hasRepoToken(`Basic ${btoa('x:')}`)).toBe(false)
	expect(hasRepoToken('Bearer tok_1')).toBe(true)
	expect(hasRepoToken('Bearer ')).toBe(false)
	expect(hasRepoToken(undefined)).toBe(false)
})

test('serves push and clone for a repo created on first use', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'mock-git-'))
	const server = await startMockArtifactsGitServer({
		root: path.join(dir, 'remotes'),
	})
	try {
		const remote = `${server.origin}/git/production/repo-1.git`
		const authed = remote.replace('http://', 'http://x:token@')
		const anonymous = await fetch(`${remote}/info/refs?service=git-upload-pack`)
		expect(anonymous.status).toBe(401)
		const work = path.join(dir, 'work')
		// The server runs in this process, so git must not block the event loop.
		const git = async (cwd: string, ...args: Array<string>) =>
			(await promisify(execFile)('git', args, { cwd, encoding: 'utf8' })).stdout
		await git(dir, 'init', '--quiet', '--initial-branch=main', work)
		await writeFile(path.join(work, 'README.md'), 'hello\n')
		await git(work, 'add', 'README.md')
		await git(
			work,
			'-c',
			'user.email=t@example.com',
			'-c',
			'user.name=t',
			'commit',
			'-qm',
			'init',
		)
		await git(work, 'push', '--quiet', authed, 'main')
		const clone = path.join(dir, 'clone')
		await git(dir, 'clone', '--quiet', authed, clone)
		expect(await git(clone, 'log', '--format=%s')).toBe('init\n')
	} finally {
		await server.close()
		await rm(dir, { recursive: true, force: true })
	}
})
