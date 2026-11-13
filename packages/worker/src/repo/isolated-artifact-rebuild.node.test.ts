import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	createIsolatedArtifactRebuildRunner,
	isolatedArtifactRebuildStagingKeyBelongsToUser,
	isolatedArtifactRebuildStagingKeyForUser,
	isolatedArtifactRebuildStagingKeyPrefix,
} from './isolated-artifact-rebuild.ts'

test('staging keys are user-namespaced and ownership-checked', () => {
	const key = isolatedArtifactRebuildStagingKeyForUser('user-1')
	expect(key.startsWith('repo-artifact-rebuild-staging:v1:user-1:')).toBe(true)
	expect(
		isolatedArtifactRebuildStagingKeyBelongsToUser({
			stagingKey: key,
			userId: ownerIdFromStored('user-2'),
		}),
	).toBe(false)
	expect(
		isolatedArtifactRebuildStagingKeyBelongsToUser({
			stagingKey: 'repo-checks-staging:v1:user-1:abc',
			userId: ownerIdFromStored('user-1'),
		}),
	).toBe(false)
})

test('createIsolatedArtifactRebuildRunner returns null without bindings', () => {
	expect(createIsolatedArtifactRebuildRunner(undefined)).toBeNull()
	expect(createIsolatedArtifactRebuildRunner({} as Env)).toBeNull()
	expect(
		createIsolatedArtifactRebuildRunner({
			REPO_SESSION: {},
		} as unknown as Env),
	).toBeNull()
	expect(
		createIsolatedArtifactRebuildRunner({
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env),
	).toBeNull()
})

test('runner touches staging TTL, fans out one target chunk per throwaway DO, and maps reset errors', async () => {
	const put = vi.fn(async () => undefined)
	const get = vi.fn(async () =>
		JSON.stringify({ sourceFiles: { 'package.json': '{}' } }),
	)
	const del = vi.fn(async () => undefined)
	const runIsolatedArtifactRebuild = vi.fn(async () => ({
		ok: true,
		message: 'rebuilt',
	}))
	const idFromName = vi.fn((name: string) => ({ name }))
	const getStub = vi.fn(() => ({ runIsolatedArtifactRebuild }))
	const runner = createIsolatedArtifactRebuildRunner({
		REPO_SESSION: { idFromName, get: getStub },
		BUNDLE_ARTIFACTS_KV: { put, get, delete: del },
	} as unknown as Env)
	expect(runner).not.toBeNull()
	if (!runner) throw new Error('expected runner')

	const stagingKey = `${isolatedArtifactRebuildStagingKeyPrefix}user-1:stage-1`
	await runner.touch(stagingKey)
	expect(get).toHaveBeenCalledWith(stagingKey, 'text')
	expect(put).toHaveBeenCalledWith(
		stagingKey,
		JSON.stringify({ sourceFiles: { 'package.json': '{}' } }),
		{ expirationTtl: 15 * 60 },
	)

	const target = {
		kind: 'module' as const,
		artifactName: '.',
		entryPoint: 'src/index.ts',
		bundleKind: 'module' as const,
	}
	const runInput = {
		stagingKey,
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		publishedCommit: 'commit-1',
		targets: [target],
	}
	const outcome = await runner.run({
		...runInput,
		baseUrl: 'https://kody.test',
	})
	expect(outcome.ok).toBe(true)
	expect(idFromName).toHaveBeenCalledWith(
		expect.stringMatching(/^isolated-artifact-rebuild-user-1-/),
	)
	expect(runIsolatedArtifactRebuild).toHaveBeenCalledWith({
		...runInput,
		baseUrl: 'https://kody.test',
	})

	runIsolatedArtifactRebuild.mockRejectedValueOnce(
		new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		),
	)
	const resetOutcome = await runner.run(runInput)
	expect(resetOutcome.ok).toBe(false)
	expect(resetOutcome.message).toContain('memory or CPU limits')
	expect(resetOutcome.message).toContain(
		'search({ entity: "guide:heavy_work_offload" })',
	)
	expect(resetOutcome.results).toEqual([
		expect.objectContaining({ ok: false, target }),
	])

	// Deploy resets must not be remapped to "package too large" — callers retry.
	runIsolatedArtifactRebuild.mockRejectedValueOnce(
		new Error('Durable Object reset because its code was updated.'),
	)
	await expect(runner.run(runInput)).rejects.toThrow(
		'Durable Object reset because its code was updated.',
	)

	await runner.discard(stagingKey)
	expect(del).toHaveBeenCalledWith(stagingKey)
})

test('targets that build the same bundle share one isolate chunk', async () => {
	const { chunkArtifactTargetsPerIsolate, isolatedArtifactRebuildChunkSize } =
		await import('./isolated-artifact-rebuild.ts')
	// The reported shape: an export and five jobs on one entry file that
	// statically imports a large kody:@ package.
	const jobTargets = [
		'daily-week-0635-0650',
		'daily-week-0640-0655',
		'daily-week-0645',
		'daily-week-0700',
		'daily-week-check',
	].map((artifactName) => ({
		kind: 'job' as const,
		artifactName,
		entryPoint: 'src/job.ts',
		bundleKind: 'module' as const,
	}))
	const targets = [
		{
			kind: 'module' as const,
			artifactName: '.',
			entryPoint: 'src/job.ts',
			bundleKind: 'module' as const,
		},
		{
			kind: 'importable-module' as const,
			artifactName: '.',
			entryPoint: 'src/job.ts',
			bundleKind: 'importable-module' as const,
		},
		...jobTargets,
	]
	const chunks = chunkArtifactTargetsPerIsolate(targets)
	expect(chunks).toHaveLength(1)
	expect(new Set(chunks[0])).toEqual(new Set(targets))
	const distinctEntries = Array.from(
		{ length: isolatedArtifactRebuildChunkSize + 1 },
		(_, index) => ({
			kind: 'job' as const,
			artifactName: `job-${index}`,
			entryPoint: `src/job-${index}.ts`,
			bundleKind: 'module' as const,
		}),
	)
	expect(
		chunkArtifactTargetsPerIsolate([...distinctEntries, ...jobTargets]).map(
			(chunk) => chunk.length,
		),
	).toEqual([isolatedArtifactRebuildChunkSize, 1 + jobTargets.length])
})

test('memoized builders build an export and the jobs on its entry once', async () => {
	const {
		buildPublishedPackageArtifactTargetBundle,
		memoizePublishedPackageArtifactBuilders,
	} =
		await import('#worker/package-runtime/published-bundle-artifact-persist.ts')
	const calls: Array<string> = []
	const bundle = (label: string) => async (args: { entryPoint: string }) => {
		calls.push(`${label}:${args.entryPoint}`)
		return { mainModule: 'bundle.js', modules: {}, dependencies: [] }
	}
	const builders = memoizePublishedPackageArtifactBuilders({
		buildAppBundle: bundle('app'),
		buildAppClientBundle: bundle('app-client'),
		buildModuleBundle: bundle('module'),
		buildImportableModuleBundle: bundle('importable-module'),
	})
	const targets = [
		{ kind: 'module', entryPoint: 'src/job.ts', bundleKind: 'module' },
		{
			kind: 'importable-module',
			entryPoint: 'src/job.ts',
			bundleKind: 'importable-module',
		},
		...['a', 'b', 'c', 'd', 'e'].map((artifactName) => ({
			kind: 'job',
			artifactName,
			entryPoint: 'src/job.ts',
			bundleKind: 'module',
		})),
		{
			kind: 'job',
			artifactName: 'f',
			entryPoint: 'src/other.ts',
			bundleKind: 'module',
		},
	] as const
	const built = await Promise.all(
		targets.map((target) =>
			buildPublishedPackageArtifactTargetBundle({ ...builders, target }),
		),
	)
	expect(calls.sort()).toEqual([
		'importable-module:src/job.ts',
		'module:src/job.ts',
		'module:src/other.ts',
	])
	expect(built[0]).toBe(built[2])
})
