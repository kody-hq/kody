import { expect, test, vi } from 'vitest'
import { wrapArtifactsGitHttpError } from '#worker/repo/artifacts-git-retry.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	forkOriginCommitCandidates,
	missingCommunityForkSnapshotMessage,
	missingPrivateForkSnapshotMessage,
	resolveForkOriginSourceFiles,
} from './fork-origin-source.ts'
import { CommunityForkResourceLimitError } from './fork-resource-limit.ts'

const mocks = vi.hoisted(() => ({
	readPublishedSourceSnapshot: vi.fn(),
	readArtifactSourceSnapshot: vi.fn(),
	readArtifactTreeAtCommit: vi.fn(),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readPublishedSourceSnapshot(...args),
}))

vi.mock('#worker/repo/artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactTreeAtCommit: (...args: Array<unknown>) =>
		mocks.readArtifactTreeAtCommit(...args),
}))

const env = { BUNDLE_ARTIFACTS_KV: {} } as Env

const listingPinFiles = {
	'package.json': '{"name":"@owner/demo","kody":{"id":"demo"}}',
	'README.md': '# pin',
}

const publishedFiles = {
	'package.json': '{"name":"@owner/demo","kody":{"id":"demo"}}',
	'README.md': '# published',
}

const gitFiles = {
	'package.json': '{"name":"@owner/demo","kody":{"id":"demo"}}',
	'README.md': '# from-git',
	'src/index.ts': 'export default async function main() {}',
}

function resetMocks() {
	mocks.readPublishedSourceSnapshot.mockReset()
	mocks.readArtifactSourceSnapshot.mockReset()
	mocks.readArtifactTreeAtCommit.mockReset()
	mocks.readPublishedSourceSnapshot.mockResolvedValue(null)
	mocks.readArtifactSourceSnapshot.mockResolvedValue(null)
	mocks.readArtifactTreeAtCommit.mockResolvedValue(null)
}

test('forkOriginCommitCandidates de-dupes preferred then fallbacks', () => {
	expect(
		forkOriginCommitCandidates({
			preferredCommit: 'head',
			fallbackCommits: ['pin', 'head', 'published', '', null, 'pin'],
		}),
	).toEqual(['head', 'pin', 'published'])
})

test('resolveForkOriginSourceFiles prefers a published KV snapshot at HEAD', async () => {
	resetMocks()
	mocks.readPublishedSourceSnapshot.mockImplementation(
		async (input: { publishedCommit: string }) =>
			input.publishedCommit === 'head-commit'
				? { files: publishedFiles }
				: null,
	)

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: 'source-1',
		repoId: 'repo-1',
		preferredCommit: 'head-commit',
		fallbackCommits: ['pin-commit'],
		listingSnapshotFiles: listingPinFiles,
		listingSnapshotCommit: 'pin-commit',
	})

	expect(resolved).toEqual({
		files: publishedFiles,
		commit: 'head-commit',
		source: 'published-snapshot',
	})
	expect(mocks.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('resolveForkOriginSourceFiles tries HEAD git before accepting a pin-keyed published snapshot', async () => {
	resetMocks()
	mocks.readPublishedSourceSnapshot.mockImplementation(
		async (input: { publishedCommit: string }) =>
			input.publishedCommit === 'pin-commit' ? { files: publishedFiles } : null,
	)
	mocks.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }) =>
			input.commit === 'head-commit' ? gitFiles : null,
	)

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: 'source-1',
		repoId: 'repo-1',
		preferredCommit: 'head-commit',
		fallbackCommits: ['pin-commit'],
		listingSnapshotFiles: listingPinFiles,
		listingSnapshotCommit: 'pin-commit',
	})

	expect(resolved).toEqual({
		files: gitFiles,
		commit: 'head-commit',
		source: 'artifact-git-tree',
	})
	expect(mocks.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-1',
		commit: 'head-commit',
	})
	expect(mocks.readPublishedSourceSnapshot).not.toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'pin-commit' }),
	)
})

test('resolveForkOriginSourceFiles falls back to the listing pin after HEAD and pin cascades miss', async () => {
	resetMocks()

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: 'source-1',
		repoId: 'repo-1',
		preferredCommit: 'head-commit',
		fallbackCommits: ['pin-commit'],
		listingSnapshotFiles: listingPinFiles,
		listingSnapshotCommit: 'pin-commit',
	})

	expect(resolved).toEqual({
		files: listingPinFiles,
		commit: 'pin-commit',
		source: 'listing-snapshot',
	})
	expect(mocks.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-1',
		commit: 'head-commit',
	})
	expect(mocks.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-1',
		commit: 'pin-commit',
	})
})

test('resolveForkOriginSourceFiles recovers a missing target revision from origin git objects', async () => {
	resetMocks()
	// Published KV missing at both HEAD and the historical pin (Sentry-shaped).
	mocks.readPublishedSourceSnapshot.mockResolvedValue(null)
	mocks.readArtifactSourceSnapshot.mockResolvedValue(null)
	mocks.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }) =>
			input.commit === '3f45921ca1964c49a3be12b5a836117829adccb0'
				? gitFiles
				: null,
	)

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: '5979df3e-7fb9-43ed-b53d-8742568eaa59',
		repoId: 'repo-origin',
		preferredCommit: '3f45921ca1964c49a3be12b5a836117829adccb0',
		fallbackCommits: ['3f45921ca1964c49a3be12b5a836117829adccb0'],
		listingSnapshotFiles: null,
		listingSnapshotCommit: '3f45921ca1964c49a3be12b5a836117829adccb0',
	})

	expect(resolved).toEqual({
		files: gitFiles,
		commit: '3f45921ca1964c49a3be12b5a836117829adccb0',
		source: 'artifact-git-tree',
	})
	expect(mocks.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-origin',
		commit: '3f45921ca1964c49a3be12b5a836117829adccb0',
	})
	// Recovery is read-only: no persist helpers are involved in this module.
})

test('resolveForkOriginSourceFiles tries the pinned commit when HEAD published, mock, and git miss', async () => {
	resetMocks()
	mocks.readPublishedSourceSnapshot.mockImplementation(
		async (input: { publishedCommit: string }) =>
			input.publishedCommit === 'pin-commit' ? { files: publishedFiles } : null,
	)

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: 'source-1',
		repoId: 'repo-1',
		preferredCommit: 'head-commit',
		fallbackCommits: ['pin-commit'],
		listingSnapshotFiles: null,
	})

	expect(resolved).toEqual({
		files: publishedFiles,
		commit: 'pin-commit',
		source: 'published-snapshot',
	})
	expect(mocks.readPublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'head-commit' }),
	)
	expect(mocks.readArtifactTreeAtCommit).toHaveBeenCalledWith({
		env,
		repoId: 'repo-1',
		commit: 'head-commit',
	})
	expect(mocks.readPublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'pin-commit' }),
	)
})

test('resolveForkOriginSourceFiles returns null when refs-shaped commits have no objects or snapshots', async () => {
	resetMocks()
	mocks.readArtifactTreeAtCommit.mockRejectedValue(
		new Error('Artifacts git fetch failed: commit not found'),
	)

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: 'source-1',
		repoId: 'repo-1',
		preferredCommit: 'missing-commit',
		fallbackCommits: ['also-missing'],
		listingSnapshotFiles: null,
	})

	expect(resolved).toBeNull()
	expect(missingCommunityForkSnapshotMessage('listing-1')).toContain(
		'listing-1',
	)
	expect(
		missingPrivateForkSnapshotMessage({
			packageId: 'pkg-1',
			commit: 'missing-commit',
		}),
	).toContain('pkg-1')
})

test('resolveForkOriginSourceFiles uses the mock snapshot API before git walk', async () => {
	resetMocks()
	mocks.readArtifactSourceSnapshot.mockResolvedValue({
		published_commit: 'head-commit',
		files: publishedFiles,
	})

	const resolved = await resolveForkOriginSourceFiles({
		env,
		sourceId: 'source-1',
		repoId: 'repo-1',
		preferredCommit: 'head-commit',
		listingSnapshotFiles: null,
	})

	expect(resolved).toEqual({
		files: publishedFiles,
		commit: 'head-commit',
		source: 'artifact-snapshot-api',
	})
	expect(mocks.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('resolveForkOriginSourceFiles rethrows transient Artifacts git failures', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})
	mocks.readArtifactTreeAtCommit.mockRejectedValue(
		wrapArtifactsGitHttpError({
			operation: 'git fetch',
			remote: 'https://example.test/repo.git',
			error: Object.assign(new Error('HTTP Error: 503'), {
				data: { statusCode: 503 },
			}),
		}),
	)

	await expect(
		resolveForkOriginSourceFiles({
			env,
			sourceId: 'source-1',
			repoId: 'repo-1',
			preferredCommit: 'head-commit',
			listingSnapshotFiles: null,
		}),
	).rejects.toMatchObject({ name: 'ArtifactsGitUnavailableError' })
	expect(consoleError).toHaveBeenCalled()
})

test('resolveForkOriginSourceFiles rethrows isolate memory limit failures', async () => {
	resetMocks()
	mocks.readArtifactTreeAtCommit.mockRejectedValue(
		new CommunityForkResourceLimitError(
			Object.assign(new Error('Worker exceeded memory limit'), {
				code: 'MEMORY_LIMIT',
			}),
		),
	)

	await expect(
		resolveForkOriginSourceFiles({
			env,
			sourceId: 'source-1',
			repoId: 'repo-1',
			preferredCommit: 'head-commit',
			listingSnapshotFiles: null,
		}),
	).rejects.toBeInstanceOf(CommunityForkResourceLimitError)
})
