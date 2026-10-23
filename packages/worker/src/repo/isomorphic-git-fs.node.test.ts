import { InMemoryFs } from '@cloudflare/shell'
import rawGit from 'isomorphic-git'
import { expect, test } from 'vitest'
import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'

type RawGitInitFs = Parameters<typeof rawGit.init>[0]['fs']
type RawGitPushHttp = Parameters<typeof rawGit.push>[0]['http']

test('workspace filesystem adapter supports raw isomorphic-git operations', async () => {
	const workspaceFileSystem = new InMemoryFs()
	await workspaceFileSystem.mkdir('/session', { recursive: true })
	const gitFs = createIsomorphicGitFs(workspaceFileSystem)
	const fs = gitFs as RawGitInitFs

	await rawGit.init({ fs, dir: '/session', defaultBranch: 'main' })
	await workspaceFileSystem.writeFile('/session/README.md', 'hello\n')
	await rawGit.add({ fs, dir: '/session', filepath: 'README.md' })
	const commit = await rawGit.commit({
		fs,
		dir: '/session',
		message: 'Initial commit',
		author: {
			name: 'Kody Test',
			email: 'test@local.invalid',
		},
	})

	expect(await rawGit.resolveRef({ fs, dir: '/session', ref: 'HEAD' })).toBe(
		commit,
	)

	await rawGit.addRemote({
		fs,
		dir: '/session',
		remote: 'origin',
		url: 'https://artifacts.invalid/repo.git',
	})
	const transportReached = new Error('raw Git push reached HTTP transport')
	const http = {
		request: async () => {
			throw transportReached
		},
	} as RawGitPushHttp

	await expect(
		rawGit.push({
			fs,
			http,
			dir: '/session',
			remote: 'origin',
			ref: 'main',
		}),
	).rejects.toBe(transportReached)

	await workspaceFileSystem.writeFile('/remove-me.txt', 'temporary')
	await workspaceFileSystem.mkdir('/remove-me')
	await gitFs.promises.unlink('/remove-me.txt')
	await gitFs.promises.rmdir('/remove-me')
	await expect(workspaceFileSystem.stat('/remove-me.txt')).rejects.toThrow(
		Error,
	)
	await expect(workspaceFileSystem.stat('/remove-me')).rejects.toThrow(Error)
})
