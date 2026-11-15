import type git from 'isomorphic-git'
import { expect, test, vi } from 'vitest'
import type * as Artifacts from './artifacts.ts'
import {
	readArtifactFileAtCommit,
	readArtifactTreeAtCommit,
} from './artifact-file.ts'

const mocks = vi.hoisted(() => ({
	addRemote: vi.fn(),
	fetch: vi.fn(),
	init: vi.fn(),
	readBlob: vi.fn(),
	walk: vi.fn(),
	TREE: vi.fn((input?: Parameters<typeof git.TREE>[0]) => input),
	resolveExistingArtifactSourceRepo: vi.fn(),
	isSnapshotOnlyArtifactsRemote: vi.fn<
		typeof Artifacts.isSnapshotOnlyArtifactsRemote
	>(() => false),
	readArtifactSourceSnapshot: vi.fn(),
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: {
			addRemote: (...args: Array<unknown>) => mocks.addRemote(...args),
			fetch: (...args: Array<unknown>) => mocks.fetch(...args),
			init: (...args: Array<unknown>) => mocks.init(...args),
			readBlob: (...args: Array<unknown>) => mocks.readBlob(...args),
			walk: (...args: Array<unknown>) => mocks.walk(...args),
			TREE: (...args: Parameters<typeof git.TREE>) => mocks.TREE(...args),
		},
		http: {},
	}),
}))

vi.mock('./artifacts.ts', () => {
	return {
		buildArtifactsGitAuth: () => ({ username: 'x', password: 'token' }),
		buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) =>
			remote,
		isSnapshotOnlyArtifactsRemote: (
			...args: Parameters<typeof Artifacts.isSnapshotOnlyArtifactsRemote>
		) => mocks.isSnapshotOnlyArtifactsRemote(...args),
		resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
			mocks.resolveExistingArtifactSourceRepo(...args),
	}
})

vi.mock('./artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readArtifactSourceSnapshot(...args),
}))

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
const treeCommit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

function mockArtifactRepo(
	remote = 'https://artifacts.example.test/package.git',
) {
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({ remote, defaultBranch: 'main' })),
		createToken: vi.fn(async () => ({ plaintext: 'token' })),
	})
}

function readIcon() {
	return readArtifactFileAtCommit({
		env: {} as Env,
		repoId: 'package-1',
		commit: 'abc123',
		filePath: 'community-icon.png',
	})
}

function readTree() {
	return readArtifactTreeAtCommit({
		env: {} as Env,
		repoId: 'package-1',
		commit: treeCommit,
	})
}

function gitError(message: string, code: string, extra = {}) {
	return Object.assign(new Error(message), { code, name: code, ...extra })
}

test('reads binary artifact files from an exact pinned commit', async () => {
	mockArtifactRepo()
	mocks.readBlob.mockResolvedValue({ blob: pngBytes })

	await expect(readIcon()).resolves.toEqual(pngBytes)
	expect(mocks.init).toHaveBeenCalledWith(
		expect.objectContaining({ dir: '/repo' }),
	)
	expect(mocks.addRemote).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			remote: 'origin',
			url: 'https://artifacts.example.test/package.git',
		}),
	)
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'abc123',
			depth: 1,
			singleBranch: true,
			tags: false,
		}),
	)
	expect(mocks.addRemote.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.fetch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
	)
	expect(mocks.readBlob).toHaveBeenCalledWith(
		expect.objectContaining({ oid: 'abc123', filepath: 'community-icon.png' }),
	)

	mocks.fetch.mockClear()
	mocks.fetch
		.mockRejectedValueOnce(
			gitError('HTTP Error: 500 Internal Server Error', 'HttpError', {
				data: {
					statusCode: 500,
					statusMessage: 'Internal Server Error',
					response: '',
				},
			}),
		)
		.mockResolvedValueOnce(undefined)
	await expect(readIcon()).resolves.toEqual(pngBytes)
	expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

test('retries packfile corruption on readBlob after fetch and does not retry missing files (KODY-CLOUDFLARE-56)', async () => {
	mockArtifactRepo()
	mocks.readBlob
		.mockRejectedValueOnce(
			gitError(
				`An internal error caused this command to fail.\n\nIf you're using an application that depends on isomorphic-git, please report this error to that application's developers.\n\nIf you're a developer and you believe this is a bug in isomorphic-git, please file an issue at https://github.com/isomorphic-git/isomorphic-git/issues with a minimal reproduction, version and environment details, and this error message: Packfile payload corrupted: calculated abc but expected def. The packfile may have been tampered with.`,
				'InternalError',
			),
		)
		.mockResolvedValueOnce({ blob: pngBytes })

	await expect(readIcon()).resolves.toEqual(pngBytes)
	// Fresh workspace + fetch on each attempt (corruption on read must re-fetch).
	expect(mocks.fetch).toHaveBeenCalledTimes(2)
	expect(mocks.init).toHaveBeenCalledTimes(2)
	expect(mocks.readBlob).toHaveBeenCalledTimes(2)

	vi.clearAllMocks()
	mocks.readBlob.mockRejectedValue(
		gitError('Could not find community-icon.png', 'NotFoundError'),
	)
	await expect(readIcon()).resolves.toBeNull()
	expect(mocks.fetch).toHaveBeenCalledTimes(1)
	expect(mocks.readBlob).toHaveBeenCalledTimes(1)
})

test('readArtifactTreeAtCommit walks the fetched commit tree', async () => {
	mockArtifactRepo()
	const communityIcon = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1])
	const photo = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x4a])
	const entries: Array<[string, 'tree' | 'blob' | null, Uint8Array]> = [
		['.', null, new Uint8Array()],
		['src', 'tree', new Uint8Array()],
		['README.md', 'blob', new TextEncoder().encode('# Hello\n')],
		['__proto__', 'blob', new TextEncoder().encode('not proto\n')],
		['community-icon.png', 'blob', communityIcon],
		['other-icon.png', 'blob', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 2])],
		['photo.jpg', 'blob', photo],
	]
	mocks.walk.mockImplementation(
		async (input: {
			map: (filepath: string, entries: Array<unknown>) => Promise<void>
		}) => {
			for (const [path, type, bytes] of entries) {
				await input.map(path, [
					type && { type: async () => type, content: async () => bytes },
				])
			}
		},
	)

	const tree = await readTree()
	expect(tree?.['README.md']).toBe('# Hello\n')
	expect(Object.hasOwn(tree ?? {}, '__proto__')).toBe(true)
	expect(tree?.['__proto__']).toBe('not proto\n')
	expect(tree?.['community-icon.png']).not.toBe(tree?.['other-icon.png'])
	expect(tree?.['community-icon.png']).toBe(
		String.fromCharCode(...communityIcon),
	)
	expect(tree?.['community-icon.png']).toContain('\0')
	expect(tree?.['photo.jpg']).toBe(String.fromCharCode(...photo))
	expect(tree?.['photo.jpg']).not.toContain('\0')
	expect(mocks.TREE).toHaveBeenCalledWith({ ref: treeCommit })
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({ ref: treeCommit, depth: 1 }),
	)
})

test('readArtifactTreeAtCommit returns null when a loopback snapshot is missing', async () => {
	mocks.isSnapshotOnlyArtifactsRemote.mockReturnValue(true)
	mockArtifactRepo('http://127.0.0.1/package.git')
	mocks.readArtifactSourceSnapshot.mockResolvedValueOnce(null)
	await expect(readTree()).resolves.toBeNull()

	mocks.readArtifactSourceSnapshot.mockResolvedValueOnce({ files: {} })
	await expect(readTree()).resolves.toEqual({})
})
