import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getArtifactsBinding: vi.fn(),
	isArtifactRepoNotFoundError: vi.fn(),
	isSnapshotOnlyArtifactsRemote: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	readArtifactFileAtCommit: vi.fn(),
	readArtifactTreeAtCommit: vi.fn(),
	writeArtifactSourceSnapshot: vi.fn(),
	writePublishedSourceSnapshot: vi.fn(),
	updateEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsBinding: (...args: Array<unknown>) =>
		mockModule.getArtifactsBinding(...args),
	isArtifactRepoNotFoundError: (...args: Array<unknown>) =>
		mockModule.isArtifactRepoNotFoundError(...args),
	isSnapshotOnlyArtifactsRemote: (...args: Array<unknown>) =>
		mockModule.isSnapshotOnlyArtifactsRemote(...args),
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mockModule.resolveExistingArtifactSourceRepo(...args),
}))

vi.mock('./artifact-file.ts', () => ({
	readArtifactFileAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactFileAtCommit(...args),
	readArtifactTreeAtCommit: (...args: Array<unknown>) =>
		mockModule.readArtifactTreeAtCommit(...args),
}))

vi.mock('./artifact-source-snapshot.ts', () => ({
	writeArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writeArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	writePublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.writePublishedSourceSnapshot(...args),
}))

vi.mock('./entity-sources.ts', () => ({
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('./source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

const { forkArtifactRepo, persistForkedArtifactRepoContents } =
	await import('./artifact-repo-fork.ts')

const env = { APP_DB: {} as D1Database } as Env
const source = {
	id: 'source-1',
	user_id: ownerIdFromStored('user-1'),
	entity_kind: 'package' as const,
	entity_id: 'package-1',
	repo_id: 'package-dest',
	published_commit: null,
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-09-08T00:00:00.000Z',
	updated_at: '2026-09-08T00:00:00.000Z',
}

const janeManifest = '{"name":"@jane/demo"}'
const tabbedJson = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`

function mockDestRemote(remote: string, headCommit?: string | null) {
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({ remote }),
	})
	mockModule.isSnapshotOnlyArtifactsRemote.mockReturnValue(
		remote.startsWith('http://127.0.0.1'),
	)
	if (headCommit !== undefined) {
		mockModule.resolveArtifactSourceHead.mockResolvedValue({
			branch: 'main',
			commit: headCommit,
		})
	}
	mockModule.updateEntitySource.mockResolvedValue(true)
}

const productionRemote =
	'https://acct.artifacts.cloudflare.net/git/default/package-dest.git'

function persist(
	overrides: Partial<Parameters<typeof persistForkedArtifactRepoContents>[0]>,
) {
	return persistForkedArtifactRepoContents({
		env,
		baseUrl: 'https://kody.test',
		userId: ownerIdFromStored('user-1'),
		source,
		originCommit: 'commit-origin',
		expectedPackageScope: 'jane',
		targetKodyId: 'demo',
		changedFiles: { 'package.json': janeManifest },
		files: { 'package.json': janeManifest, 'poster.png': 'huge-binary' },
		...overrides,
	})
}

test('forkArtifactRepo delegates to the Artifacts binding fork', async () => {
	const fork = vi.fn(async () => ({
		id: 'repo_dest',
		name: 'package-dest',
		description: null,
		defaultBranch: 'main',
		remote: 'https://example.test/git/package-dest.git',
		token: 'tok',
		expiresAt: '2026-09-08T01:00:00.000Z',
	}))
	mockModule.getArtifactsBinding.mockReturnValue({ fork })

	await expect(
		forkArtifactRepo({
			env,
			sourceRepoId: 'package-origin',
			targetRepoId: 'package-dest',
		}),
	).resolves.toMatchObject({ name: 'package-dest' })
	expect(fork).toHaveBeenCalledWith('package-origin', 'package-dest', {
		readOnly: false,
		defaultBranchOnly: true,
	})
})

test('persistForkedArtifactRepoContents writes the full rewritten tree on loopback remotes', async () => {
	mockDestRemote('http://127.0.0.1:1/git/default/package-dest.git')
	mockModule.writeArtifactSourceSnapshot.mockResolvedValue({
		published_commit: 'commit-loopback',
		files: {},
	})

	await expect(persist({})).resolves.toEqual({
		copiedOriginCommit: 'commit-origin',
		destCommit: 'commit-loopback',
	})
	expect(mockModule.writeArtifactSourceSnapshot).toHaveBeenCalledWith({
		env,
		repoId: 'package-dest',
		files: { 'package.json': janeManifest, 'poster.png': 'huge-binary' },
	})
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('persistForkedArtifactRepoContents syncs only changed files on production remotes', async () => {
	mockDestRemote(productionRemote, 'commit-origin')
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-edited')

	await expect(persist({})).resolves.toEqual({
		copiedOriginCommit: 'commit-origin',
		destCommit: 'commit-edited',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: { 'package.json': janeManifest },
			existingHeadCommit: 'commit-origin',
		}),
	)
	expect(mockModule.readArtifactFileAtCommit).not.toHaveBeenCalled()
})

test('persistForkedArtifactRepoContents stamps dest HEAD and rewrites only dest package.json when dest HEAD is ahead of the pin and its tree is unreadable', async () => {
	mockDestRemote(productionRemote, 'commit-head')
	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode(
			tabbedJson({
				name: '@kody/doom',
				version: '2.0.0',
				kody: { id: 'doom', extra: true },
			}),
		),
	)
	mockModule.readArtifactTreeAtCommit.mockRejectedValue(
		new Error('tree unavailable'),
	)
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-rewritten')
	const pinManifest = '{"name":"@jane/demo","version":"1.0.0"}'

	await expect(
		persist({
			originCommit: 'commit-pin',
			changedFiles: {
				'package.json': pinManifest,
				'README.md': 'rewritten from the listing pin',
			},
			files: {
				'package.json': pinManifest,
				'README.md': 'rewritten from the listing pin',
				'poster.png': 'huge-binary',
			},
		}),
	).resolves.toEqual({
		copiedOriginCommit: 'commit-head',
		destCommit: 'commit-rewritten',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.readArtifactFileAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'package-dest',
		commit: 'commit-head',
		filePath: 'package.json',
	})
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			existingHeadCommit: 'commit-head',
			files: {
				'package.json': tabbedJson({
					name: '@jane/demo',
					version: '2.0.0',
					kody: { extra: true },
					private: true,
				}),
			},
		}),
	)
})

test('persistForkedArtifactRepoContents renames emits topics across dest HEAD files when dest is ahead of the pin', async () => {
	mockDestRemote(productionRemote, 'commit-head')
	const headManifest = tabbedJson({
		name: '@kody/github',
		kody: { emits: { '@kody/github.pr.merged': { description: 'Merged' } } },
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode(headManifest),
	)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'package.json': headManifest,
		'src/topics.ts': "export const merged = '@kody/github.pr.merged'\n",
		'README.md': '# untouched',
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-rewritten')

	await persist({ originCommit: 'commit-pin', targetKodyId: 'github' })

	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'package-dest',
		commit: 'commit-head',
	})
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenLastCalledWith(
		expect.objectContaining({
			existingHeadCommit: 'commit-head',
			files: {
				'package.json': tabbedJson({
					name: '@jane/github',
					kody: {
						emits: { '@jane/github.pr.merged': { description: 'Merged' } },
					},
					private: true,
				}),
				'src/topics.ts': "export const merged = '@jane/github.pr.merged'\n",
			},
		}),
	)
})

test('persistForkedArtifactRepoContents rewrites and scans dest HEAD files for the fork name when dest is ahead of the pin', async () => {
	mockDestRemote(productionRemote, 'commit-head')
	const headManifest = tabbedJson({ name: '@kody/github' })
	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode(headManifest),
	)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'package.json': headManifest,
		'src/key.ts': 'const leaf = topic.replace(/^@kody\\/github\\./, "")\n',
		'src/odd.ts': 'const name = "\\u0040kody/github"\n',
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-rewritten')

	await expect(
		persist({
			originCommit: 'commit-pin',
			targetKodyId: 'github',
			changedFiles: { 'README.md': 'rewritten from the listing pin' },
		}),
	).resolves.toEqual({
		copiedOriginCommit: 'commit-head',
		destCommit: 'commit-rewritten',
		leftoverOriginReferences: [
			{
				file: 'src/odd.ts',
				line: 1,
				snippet: 'const name = "\\u0040kody/github"',
			},
		],
	})
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenLastCalledWith(
		expect.objectContaining({
			files: {
				'package.json': tabbedJson({
					name: '@jane/github',
					private: true,
					kody: {},
				}),
				'src/key.ts': 'const leaf = topic.replace(/^@jane\\/github\\./, "")\n',
			},
		}),
	)
})

test('persistForkedArtifactRepoContents rejects a forked dest with no HEAD', async () => {
	mockDestRemote(productionRemote, null)

	await expect(
		persist({
			originCommit: 'commit-pin',
			files: { 'package.json': janeManifest },
		}),
	).rejects.toThrow(/default branch has no HEAD/)
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('persistForkedArtifactRepoContents stamps dest HEAD only when the rewrite is already a no-op, failing closed when the stamp misses', async () => {
	const noOpRewrite = {
		originCommit: 'commit-head',
		changedFiles: {},
		files: { 'package.json': janeManifest },
	}
	mockDestRemote(productionRemote, 'commit-head')

	await expect(persist(noOpRewrite)).resolves.toEqual({
		copiedOriginCommit: 'commit-head',
		destCommit: 'commit-head',
	})
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({ publishedCommit: 'commit-head' }),
	)

	mockModule.updateEntitySource.mockResolvedValue(false)
	await expect(persist(noOpRewrite)).rejects.toThrow(
		/could not be marked at dest HEAD commit-head/,
	)
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('shouldFallbackFromForkedArtifactPersist matches exhausted Artifacts git dest failures only', async () => {
	const { shouldFallbackFromForkedArtifactPersist } =
		await import('./artifact-repo-fork.ts')
	expect(
		shouldFallbackFromForkedArtifactPersist(
			new Error(
				'Artifacts git clone failed for https://example.test/dest.git: HTTP Error: 500 Internal Server Error',
			),
		),
	).toBe(true)
	expect(
		shouldFallbackFromForkedArtifactPersist(
			new Error(
				'Artifacts git fetch failed for https://example.test/dest.git: Packfile payload corrupted: calculated abc but expected def.',
			),
		),
	).toBe(true)
	expect(
		shouldFallbackFromForkedArtifactPersist(
			new Error(
				'Artifacts git clone failed for https://example.test/dest.git: HTTP Error: 401 Unauthorized',
			),
		),
	).toBe(false)
	expect(
		shouldFallbackFromForkedArtifactPersist(
			new Error('package.json rewrite failed'),
		),
	).toBe(false)
})

test('resolveCommunityForkArtifactsGitFallbackTree keeps prepared files when dest HEAD matches or is missing', async () => {
	const { resolveCommunityForkArtifactsGitFallbackTree } =
		await import('./artifact-repo-fork.ts')
	const input = {
		env,
		destRepoId: 'package-dest',
		originRepoId: 'package-origin',
		preparedOriginCommit: 'commit-pin',
		preparedFiles: { 'package.json': janeManifest },
		expectedPackageScope: 'jane',
		targetKodyId: 'discord',
		listingName: '@kody/discord',
		targetName: '@jane/discord',
	}
	const kept = {
		originCommit: 'commit-pin',
		files: { 'package.json': janeManifest },
	}

	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-pin',
	})
	await expect(
		resolveCommunityForkArtifactsGitFallbackTree(input),
	).resolves.toEqual(kept)
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()

	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: null,
	})
	await expect(
		resolveCommunityForkArtifactsGitFallbackTree(input),
	).resolves.toEqual(kept)
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('resolveCommunityForkArtifactsGitFallbackTree returns null when dest HEAD lookup throws', async () => {
	const { resolveCommunityForkArtifactsGitFallbackTree } =
		await import('./artifact-repo-fork.ts')
	mockModule.resolveArtifactSourceHead.mockRejectedValue(
		new Error('Artifacts listServerRefs failed: HTTP Error: 500'),
	)
	await expect(
		resolveCommunityForkArtifactsGitFallbackTree({
			env,
			destRepoId: 'package-dest',
			originRepoId: 'package-origin',
			preparedOriginCommit: 'commit-pin',
			preparedFiles: { 'package.json': janeManifest },
			expectedPackageScope: 'jane',
			targetKodyId: 'discord',
			listingName: '@kody/discord',
			targetName: '@jane/discord',
		}),
	).resolves.toBeNull()
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('resolveCommunityForkArtifactsGitFallbackTree rewrites origin HEAD when dest is ahead of the prepared pin', async () => {
	const { resolveCommunityForkArtifactsGitFallbackTree } =
		await import('./artifact-repo-fork.ts')
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head',
	})
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'package.json': `${JSON.stringify({ name: '@kody/discord', version: '1.0.0' }, null, '\t')}\n`,
		'README.md': '# newer',
	})
	const result = await resolveCommunityForkArtifactsGitFallbackTree({
		env,
		destRepoId: 'package-dest',
		originRepoId: 'package-origin',
		preparedOriginCommit: 'commit-pin',
		preparedFiles: { 'package.json': janeManifest, 'README.md': '# older' },
		expectedPackageScope: 'jane',
		targetKodyId: 'discord',
		listingName: '@kody/discord',
		targetName: '@jane/discord',
	})
	expect(result?.originCommit).toBe('commit-head')
	expect(result?.files['README.md']).toBe('# newer')
	expect(result?.files['package.json']).toContain('@jane/discord')
	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'package-origin',
		commit: 'commit-head',
	})
})

test('resolveCommunityForkArtifactsGitFallbackTree renames emits topics in origin HEAD files', async () => {
	const { resolveCommunityForkArtifactsGitFallbackTree } =
		await import('./artifact-repo-fork.ts')
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head',
	})
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'package.json': tabbedJson({
			name: '@kody/discord',
			kody: { emits: { '@kody/discord.message.created': {} } },
		}),
		'src/emit.ts': "emit('@kody/discord.message.created')\n",
	})
	const result = await resolveCommunityForkArtifactsGitFallbackTree({
		env,
		destRepoId: 'package-dest',
		originRepoId: 'package-origin',
		preparedOriginCommit: 'commit-pin',
		preparedFiles: { 'package.json': janeManifest },
		expectedPackageScope: 'jane',
		targetKodyId: 'discord',
		listingName: '@kody/discord',
		targetName: '@jane/discord',
	})
	expect(result?.files['package.json']).toContain(
		'"@jane/discord.message.created"',
	)
	expect(result?.files['src/emit.ts']).toBe(
		"emit('@jane/discord.message.created')\n",
	)
})

test('resolveCommunityForkArtifactsGitFallbackTree returns null when dest HEAD is ahead and origin tree is unavailable', async () => {
	const { resolveCommunityForkArtifactsGitFallbackTree } =
		await import('./artifact-repo-fork.ts')
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head',
	})
	mockModule.readArtifactTreeAtCommit.mockRejectedValue(
		new Error(
			'Artifacts git fetch failed for https://example.test: HTTP Error: 500',
		),
	)
	await expect(
		resolveCommunityForkArtifactsGitFallbackTree({
			env,
			destRepoId: 'package-dest',
			originRepoId: 'package-origin',
			preparedOriginCommit: 'commit-pin',
			preparedFiles: { 'package.json': janeManifest },
			expectedPackageScope: 'jane',
			targetKodyId: 'discord',
			listingName: '@kody/discord',
			targetName: '@jane/discord',
		}),
	).resolves.toBeNull()
})
