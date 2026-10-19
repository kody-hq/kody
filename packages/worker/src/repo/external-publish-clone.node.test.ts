import type git from 'isomorphic-git'
import { expect, test, vi } from 'vitest'
import { isWorkspaceSqliteTooBigMessage } from './external-publish-clone.ts'

const gitMocks = vi.hoisted(() => ({
	clone: vi.fn(async (..._args: Parameters<typeof git.clone>) => undefined),
	log: vi.fn(async (..._args: Parameters<typeof git.log>) => [
		{ oid: 'commit-head' },
	]),
	checkout: vi.fn(
		async (..._args: Parameters<typeof git.checkout>) => undefined,
	),
	listFiles: vi.fn(async (..._args: Parameters<typeof git.listFiles>) => [
		'package.json',
		'src/index.ts',
	]),
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: {
			clone: (...args: Parameters<typeof git.clone>) => gitMocks.clone(...args),
			log: (...args: Parameters<typeof git.log>) => gitMocks.log(...args),
			checkout: (...args: Parameters<typeof git.checkout>) =>
				gitMocks.checkout(...args),
			listFiles: (...args: Parameters<typeof git.listFiles>) =>
				gitMocks.listFiles(...args),
		},
		http: {},
	}),
}))

vi.mock('./artifacts-git-retry.ts', () => ({
	runArtifactsGitWithRetry: async <T>(operation: () => Promise<T>) =>
		await operation(),
	wrapArtifactsGitHttpError: (input: {
		operation: string
		remote: string
		error: unknown
	}) =>
		new Error(
			`Artifacts ${input.operation} failed for ${input.remote}: ${String(input.error)}`,
		),
	isTransientArtifactsGitError: () => false,
}))

const { cloneExternalPublishWorkspace } =
	await import('./external-publish-clone.ts')
const { buildUnknownRequestedCommitMessage } =
	await import('./requested-commit-error.ts')

test('cloneExternalPublishWorkspace clones into ephemeral FS and exposes publish helpers', async () => {
	expect(
		isWorkspaceSqliteTooBigMessage('string or blob too big: SQLITE_TOOBIG'),
	).toBe(true)
	expect(
		isWorkspaceSqliteTooBigMessage(
			'source clone or commit checkout failed: string or blob too big: SQLITE_TOOBIG',
		),
	).toBe(true)
	expect(isWorkspaceSqliteTooBigMessage('D1 DB is overloaded')).toBe(false)

	gitMocks.clone.mockClear()
	gitMocks.log.mockClear()
	gitMocks.checkout.mockClear()
	gitMocks.listFiles.mockClear()
	gitMocks.log
		.mockResolvedValueOnce([{ oid: 'commit-head' }])
		.mockResolvedValueOnce([{ oid: 'commit-new' }, { oid: 'commit-old' }])

	const cloned = await cloneExternalPublishWorkspace({
		remote: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		token: 'art_token',
		branch: 'main',
		checkoutCommit: 'commit-new',
	})

	expect(gitMocks.clone).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			ref: 'main',
			singleBranch: true,
		}),
	)
	expect(gitMocks.checkout).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			ref: 'commit-new',
			force: true,
		}),
	)
	expect(cloned.headCommit).toBe('commit-head')
	expect(cloned.dir).toBe('/repo')
	await expect(
		cloned.isAncestorCommit({
			ancestor: 'commit-old',
			descendant: 'commit-new',
		}),
	).resolves.toBe(true)

	await cloned.filesystem.writeFile('/repo/package.json', '{"name":"@kody/x"}')
	await cloned.filesystem.writeFile(
		'/repo/src/index.ts',
		'export const ok = true\n',
	)
	await expect(cloned.workspace.readFile('/repo/package.json')).resolves.toBe(
		'{"name":"@kody/x"}',
	)
	await expect(cloned.collectFiles()).resolves.toEqual({
		'package.json': '{"name":"@kody/x"}',
		'src/index.ts': 'export const ok = true\n',
	})
	const globbed = await cloned.workspace.glob('**/*')
	expect(globbed).toEqual([
		{ path: '/repo/package.json', type: 'file' },
		{ path: '/repo/src/index.ts', type: 'file' },
	])
	// runRepoChecks passes normalizeRepoWorkspacePath('/repo') + '/**/*' → 'repo/**/*'
	await expect(cloned.workspace.glob('repo/**/*')).resolves.toEqual([
		{ path: '/repo/package.json', type: 'file' },
		{ path: '/repo/src/index.ts', type: 'file' },
	])
	await expect(cloned.workspace.glob('repo/src/**/*')).resolves.toEqual([
		{ path: '/repo/src/index.ts', type: 'file' },
	])
})

test('collectFiles keeps PNG magic byte-identical (no UTF-8 replacement)', async () => {
	const { bytesToLatin1String, snapshotStringToBytes } =
		await import('#universal/package-file-media.ts')
	const pngMagic = Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	])

	gitMocks.listFiles.mockResolvedValueOnce(['package.json', 'public/mark.png'])

	const cloned = await cloneExternalPublishWorkspace({
		remote: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		token: 'art_token',
		branch: 'main',
		checkoutCommit: 'commit-head',
	})

	await cloned.filesystem.writeFile('/repo/package.json', '{"name":"@kody/x"}')
	await cloned.filesystem.writeFileBytes('/repo/public/mark.png', pngMagic)

	// Ephemeral `readFile` UTF-8-decodes and would corrupt 0x89 → U+FFFD.
	const utf8Decoded = await cloned.filesystem.readFile('/repo/public/mark.png')
	expect(utf8Decoded.charCodeAt(0)).toBe(0xfffd)

	const collected = await cloned.collectFiles()
	expect(collected['public/mark.png']).toBe(bytesToLatin1String(pngMagic))
	expect([
		...snapshotStringToBytes(collected['public/mark.png']!, 'public/mark.png'),
	]).toEqual([...pngMagic])
})

test('checkout of an unknown full SHA is not a clone or backup failure', async () => {
	const commit = 'fedcba9876543210fedcba9876543210fedcba98'
	gitMocks.checkout.mockRejectedValueOnce(
		Object.assign(
			new Error(
				`Failed to checkout "${commit}" because commit ${commit} is not available locally. Do a git fetch to make the branch available locally.`,
			),
			{ name: 'CommitNotFetchedError', code: 'CommitNotFetchedError' },
		),
	)
	await expect(
		cloneExternalPublishWorkspace({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
			token: 'art_token',
			branch: 'main',
			checkoutCommit: commit,
		}),
	).rejects.toThrow(buildUnknownRequestedCommitMessage(commit))
})

test('checkout keeps a storage failure distinct from a clone failure', async () => {
	gitMocks.checkout.mockRejectedValueOnce(
		new Error('string or blob too big: SQLITE_TOOBIG'),
	)
	await expect(
		cloneExternalPublishWorkspace({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
			token: 'art_token',
			branch: 'main',
			checkoutCommit: '0123456789abcdef0123456789abcdef01234567',
		}),
	).rejects.toThrow('string or blob too big: SQLITE_TOOBIG')

	gitMocks.clone.mockRejectedValueOnce(new Error('HTTP Error: 500'))
	await expect(
		cloneExternalPublishWorkspace({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
			token: 'art_token',
			branch: 'main',
			checkoutCommit: '0123456789abcdef0123456789abcdef01234567',
		}),
	).rejects.toThrow(/Artifacts git clone failed/)
})
