import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as IsolatedArtifactRebuildModule from '#worker/repo/isolated-artifact-rebuild.ts'

const mockModule = vi.hoisted(() => ({
	listPublishedPackageArtifactTargets: vi.fn(),
	stagePublishedPackageArtifactRebuild: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	createIsolatedArtifactRebuildRunner: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
	reusePublishedPackageArtifactIfUnchanged: vi.fn(),
	loadPublishedBundleArtifactsForPackageTargets: vi.fn(),
	publishedBundleArtifactForPackageTarget: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		stagePublishedPackageArtifactRebuild: (...args: Array<unknown>) =>
			mockModule.stagePublishedPackageArtifactRebuild(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

vi.mock('#worker/repo/isolated-artifact-rebuild.ts', async () => {
	const actual = await vi.importActual<typeof IsolatedArtifactRebuildModule>(
		'#worker/repo/isolated-artifact-rebuild.ts',
	)
	return {
		...actual,
		createIsolatedArtifactRebuildRunner: (...args: Array<unknown>) =>
			mockModule.createIsolatedArtifactRebuildRunner(...args),
	}
})

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	isPublishedPackageArtifactBuiltForCommit: (...args: Array<unknown>) =>
		mockModule.isPublishedPackageArtifactBuiltForCommit(...args),
	reusePublishedPackageArtifactIfUnchanged: (...args: Array<unknown>) =>
		mockModule.reusePublishedPackageArtifactIfUnchanged(...args),
	loadPublishedBundleArtifactsForPackageTargets: (...args: Array<unknown>) =>
		mockModule.loadPublishedBundleArtifactsForPackageTargets(...args),
	publishedBundleArtifactForPackageTarget: (...args: Array<unknown>) =>
		mockModule.publishedBundleArtifactForPackageTarget(...args),
}))

const {
	publishedPackageArtifactRebuildD1LockRetryDelaysMs,
	rebuildPublishedPackageArtifactsViaRepoSession,
} = await import('./package-artifact-rebuild.ts')

const sampleTargets = [...'abcdefghi'].map((letter, index) => ({
	kind: 'module' as const,
	artifactName: index === 0 ? '.' : `./${letter}`,
	entryPoint: `src/${letter}.ts`,
	bundleKind: 'module' as const,
}))
type Target = (typeof sampleTargets)[number]
const stagingKey = 'repo-artifact-rebuild-staging:v1:user-1:stage-1'
const isolatedEnv = {
	REPO_SESSION: {},
	BUNDLE_ARTIFACTS_KV: {
		get: async () => null,
	},
} as unknown as Env

beforeEach(() => {
	mockModule.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
		new Map(),
	)
	mockModule.publishedBundleArtifactForPackageTarget.mockImplementation(
		(input: {
			loadedByIdentity: Map<string, null>
			sourceId: string
			target: {
				kind: string
				artifactName?: string | null
				entryPoint: string
			}
		}) =>
			input.loadedByIdentity.get(
				`${input.sourceId}:${input.target.kind}:${input.target.artifactName ?? ''}:${input.target.entryPoint}`,
			) ?? null,
	)
})

function setup({
	targets = sampleTargets,
	run = vi.fn(async () => ({ ok: true, message: 'rebuilt' })),
	isolated = true,
	stageKey = stagingKey,
}: {
	targets?: Array<Target>
	run?: ReturnType<typeof vi.fn>
	isolated?: boolean
	stageKey?: string | null
} = {}) {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)
	mockModule.reusePublishedPackageArtifactIfUnchanged.mockResolvedValue(false)
	mockModule.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
		new Map(),
	)
	mockModule.publishedBundleArtifactForPackageTarget.mockImplementation(
		(input: {
			loadedByIdentity: Map<string, null>
			sourceId: string
			target: {
				kind: string
				artifactName?: string | null
				entryPoint: string
			}
		}) =>
			input.loadedByIdentity.get(
				`${input.sourceId}:${input.target.kind}:${input.target.artifactName ?? ''}:${input.target.entryPoint}`,
			) ?? null,
	)
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)
	if (stageKey) {
		mockModule.stagePublishedPackageArtifactRebuild.mockResolvedValue({
			stagingKey: stageKey,
		})
	}
	const runner = {
		touch: vi.fn(async () => undefined),
		run,
		discard: vi.fn(async () => undefined),
	}
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue(
		isolated ? runner : null,
	)
	return runner
}

function rebuild(
	overrides: {
		env?: Env
		publishedCommit?: string
		force?: boolean
		targets?: Array<Target>
	} = {},
) {
	return rebuildPublishedPackageArtifactsViaRepoSession({
		env: isolatedEnv,
		rpcSessionId: 'session-1',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		publishedCommit: 'commit-1',
		baseUrl: 'https://kody.test',
		...overrides,
	})
}

function createGate<Input, Output>(finish: (input: Input) => Output) {
	const gate = {
		inFlight: 0,
		maxInFlight: 0,
		releases: [] as Array<() => void>,
	}
	return Object.assign(gate, {
		impl: async (input: Input) => {
			gate.inFlight += 1
			gate.maxInFlight = Math.max(gate.maxInFlight, gate.inFlight)
			await new Promise<void>((resolve) => {
				gate.releases.push(() => {
					gate.inFlight -= 1
					resolve()
				})
			})
			return finish(input)
		},
		releaseAll: () => gate.releases.splice(0).forEach((release) => release()),
	})
}

const runTargets = (run: ReturnType<typeof vi.fn>) =>
	run.mock.calls.map((call) => (call[0] as { targets: Array<Target> }).targets)

test('isolated rebuild lists then stages once, chunks targets per isolate with bounded concurrency, and discards staging', async () => {
	const gate = createGate((input: { targets: Array<Target> }) => ({
		ok: true,
		message: 'rebuilt',
		results: input.targets.map((target) => ({
			ok: true,
			message: 'rebuilt',
			target,
		})),
	}))
	const run = vi.fn(gate.impl)
	const { touch, discard } = setup({ run })

	const rebuildPromise = rebuild()

	await vi.waitFor(() => {
		expect(run).toHaveBeenCalledTimes(2)
	})
	expect(gate.maxInFlight).toBe(2)
	expect(mockModule.listPublishedPackageArtifactTargets).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
		}),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()
	expect(touch).not.toHaveBeenCalled()
	expect(runTargets(run)).toEqual([
		sampleTargets.slice(0, 4),
		sampleTargets.slice(4, 8),
	])

	gate.releaseAll()
	await vi.waitFor(() => {
		expect(run).toHaveBeenCalledTimes(3)
	})
	expect(touch).toHaveBeenCalledWith(stagingKey)
	expect(runTargets(run)[2]).toEqual(sampleTargets.slice(8))
	gate.releaseAll()
	await rebuildPromise

	expect(gate.maxInFlight).toBe(2)
	expect(run).toHaveBeenCalledTimes(3)
	expect(discard).toHaveBeenCalledWith(stagingKey)
})

test('isolated rebuild skips already-built or unchanged targets and does not stage when all are built', async () => {
	const builtOrUnchanged = async (input: { target: Target }) =>
		input.target.artifactName === '.' || input.target.artifactName === './c'
	for (const [check, publishedCommit] of [
		[mockModule.isPublishedPackageArtifactBuiltForCommit, 'commit-1'],
		[mockModule.reusePublishedPackageArtifactIfUnchanged, 'commit-2'],
	] as const) {
		const { run, discard } = setup({ targets: sampleTargets.slice(0, 3) })
		check.mockImplementation(builtOrUnchanged)

		await rebuild({ publishedCommit })

		expect(runTargets(run)).toEqual([[sampleTargets[1]]])
		expect(
			mockModule.stagePublishedPackageArtifactRebuild,
		).toHaveBeenCalledTimes(1)
		expect(discard).toHaveBeenCalledTimes(1)
		expect(check).toHaveBeenCalledTimes(3)
		expect(
			mockModule.loadPublishedBundleArtifactsForPackageTargets,
		).toHaveBeenCalledTimes(1)
	}

	const { run, discard } = setup()
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(true)

	const alreadyCurrent = await rebuild()

	expect(mockModule.listPublishedPackageArtifactTargets).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.stagePublishedPackageArtifactRebuild).not.toHaveBeenCalled()
	expect(run).not.toHaveBeenCalled()
	expect(discard).not.toHaveBeenCalled()
	expect(alreadyCurrent).toEqual({ rebuiltTargetCount: 0 })

	// Prior-commit reuse under this tip is artifact work — count it so
	// already_published.artifacts_rebuilt stays truthful.
	const reusedTargets = sampleTargets.slice(0, 3)
	setup({ targets: reusedTargets })
	mockModule.reusePublishedPackageArtifactIfUnchanged.mockResolvedValue(true)
	expect(await rebuild({ publishedCommit: 'commit-2' })).toEqual({
		rebuiltTargetCount: 3,
	})
	expect(mockModule.stagePublishedPackageArtifactRebuild).not.toHaveBeenCalled()
})

test('force rebuilds already-built targets so already_published can repair stale same-commit artifacts', async () => {
	const { run, discard } = setup()
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(true)

	await rebuild({ force: true })

	expect(
		mockModule.isPublishedPackageArtifactBuiltForCommit,
	).not.toHaveBeenCalled()
	expect(
		mockModule.reusePublishedPackageArtifactIfUnchanged,
	).not.toHaveBeenCalled()
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
	expect(run).toHaveBeenCalledTimes(3)
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({
			force: true,
			targets: sampleTargets.slice(0, 4),
		}),
	)
	expect(discard).toHaveBeenCalledTimes(1)
})

test('rebuild failure stops later chunks and reports succeeded versus failed for isolated and fallback paths', async () => {
	const failurePattern =
		/Succeeded: \{ kind "module", artifact "\.", entry "src\/a\.ts", bundle "module" \}.+Failed:.+bundle b failed/
	const isB = (target: Target) => target.artifactName === './b'

	const run = vi.fn(async (input: { targets: Array<Target> }) => ({
		ok: !input.targets.some(isB),
		message: input.targets.some(isB) ? 'bundle b failed' : 'rebuilt',
		results: input.targets.map((target) =>
			isB(target)
				? { ok: false, message: 'bundle b failed', target }
				: { ok: true, message: 'rebuilt', target },
		),
	}))
	const { touch, discard } = setup({ run })

	await expect(rebuild()).rejects.toThrow(failurePattern)
	expect(touch).not.toHaveBeenCalled()
	expect(runTargets(run)).toEqual([
		sampleTargets.slice(0, 4),
		sampleTargets.slice(4, 8),
	])
	expect(discard).toHaveBeenCalledWith(stagingKey)

	setup({ targets: sampleTargets.slice(0, 4), isolated: false })
	mockModule.rebuildPublishedPackageArtifact.mockImplementation(
		async (input: { target: Target }) => {
			if (isB(input.target)) throw new Error('bundle b failed')
			return { ok: true, target: input.target, kvKey: 'bundle-key' }
		},
	)

	await expect(rebuild({ env: {} as Env })).rejects.toThrow(failurePattern)
	expect(
		mockModule.rebuildPublishedPackageArtifact.mock.calls.map(
			(call) => (call[0] as { target: Target }).target,
		),
	).toEqual(sampleTargets.slice(0, 2))
})

test('falls back to per-target session rebuild when isolated runner bindings are missing', async () => {
	setup({ targets: sampleTargets.slice(0, 3), isolated: false })
	const gate = createGate(() => ({ ok: true }))
	mockModule.rebuildPublishedPackageArtifact.mockImplementation(gate.impl)

	const rebuildPromise = rebuild({ env: {} as Env })

	await vi.waitFor(() => {
		expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
	})
	expect(gate.maxInFlight).toBe(2)
	expect(mockModule.stagePublishedPackageArtifactRebuild).not.toHaveBeenCalled()

	gate.releaseAll()
	await vi.waitFor(() => {
		expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(3)
	})
	gate.releaseAll()
	await rebuildPromise

	expect(gate.maxInFlight).toBe(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(3)
})

async function settleRebuild<T>(pending: Promise<T>) {
	// Attach before advancing timers so exhaustion rejects are not unhandled
	// while `runAllTimersAsync` flushes nested retry delays.
	const settled = pending.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	)
	await vi.runAllTimersAsync()
	const result = await settled
	if (!result.ok) throw result.error
	return result.value
}

test('retries transient platform errors during staging and target rebuild, then exhausts', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	const codeUpdatedReset = new Error(
		'Durable Object reset because its code was updated.',
	)
	const expectOneTransientWarn = () => {
		expect(consoleWarn).toHaveBeenCalledTimes(1)
		expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(
			'rebuildPublishedPackageArtifactsViaRepoSession transient platform error',
		)
	}

	try {
		const staged = setup({ targets: [sampleTargets[0]!], stageKey: null })
		mockModule.stagePublishedPackageArtifactRebuild
			.mockRejectedValueOnce(codeUpdatedReset)
			.mockResolvedValueOnce({
				stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-retry',
			})

		await settleRebuild(rebuild())

		expect(
			mockModule.stagePublishedPackageArtifactRebuild,
		).toHaveBeenCalledTimes(2)
		expect(staged.run).toHaveBeenCalledTimes(1)
		expect(staged.discard).toHaveBeenCalledWith(
			'repo-artifact-rebuild-staging:v1:user-1:stage-retry',
		)
		expectOneTransientWarn()

		consoleWarn.mockClear()
		const d1Run = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				message: 'internal error; reference = s46pgsm6st3fg81p6qumom80',
			})
			.mockResolvedValueOnce({ ok: true, message: 'rebuilt' })
		const d1 = setup({ targets: [sampleTargets[0]!], run: d1Run })

		await settleRebuild(rebuild())

		expect(d1Run).toHaveBeenCalledTimes(2)
		expect(
			mockModule.stagePublishedPackageArtifactRebuild,
		).toHaveBeenCalledTimes(2)
		expect(d1.discard).toHaveBeenCalledTimes(2)
		expectOneTransientWarn()

		consoleWarn.mockClear()
		setup({ targets: [sampleTargets[0]!], stageKey: null })
		mockModule.stagePublishedPackageArtifactRebuild.mockRejectedValue(
			codeUpdatedReset,
		)

		await expect(settleRebuild(rebuild())).rejects.toThrow(
			/could not recover after 3 transient platform error attempts/,
		)
		expect(
			mockModule.stagePublishedPackageArtifactRebuild,
		).toHaveBeenCalledTimes(3)
		expect(consoleWarn).toHaveBeenCalledTimes(3)

		// D1 long-running export uses the longer bounded backoff (KODY-AP).
		consoleWarn.mockClear()
		const exportError = new Error(
			'D1_ERROR: Currently processing a long-running export.',
			{ cause: new Error('Currently processing a long-running export.') },
		)
		setup({ targets: [sampleTargets[0]!], stageKey: null })
		mockModule.stagePublishedPackageArtifactRebuild.mockRejectedValue(
			exportError,
		)
		await expect(settleRebuild(rebuild())).rejects.toSatisfy(
			(error: unknown) => {
				expect(error).toBeInstanceOf(Error)
				expect(String(error)).toMatch(
					new RegExp(
						`could not recover after ${publishedPackageArtifactRebuildD1LockRetryDelaysMs.length + 1} transient platform error attempts`,
					),
				)
				// Exhaustion preserves the rebuild-failure wrapper as cause so
				// exact D1 platform sentences remain walkable for toApiError.
				expect(error).toMatchObject({
					cause: expect.objectContaining({ cause: exportError }),
				})
				return true
			},
		)
		expect(
			mockModule.stagePublishedPackageArtifactRebuild,
		).toHaveBeenCalledTimes(
			publishedPackageArtifactRebuildD1LockRetryDelaysMs.length + 1,
		)
		expect(consoleWarn).toHaveBeenCalledTimes(
			publishedPackageArtifactRebuildD1LockRetryDelaysMs.length + 1,
		)
		const firstWarn = JSON.parse(String(consoleWarn.mock.calls[0]?.[0]))
		expect(firstWarn).toMatchObject({
			attempt: 1,
			nextDelayMs: publishedPackageArtifactRebuildD1LockRetryDelaysMs[0],
		})
	} finally {
		vi.useRealTimers()
	}
})

test('does not retry non-transient rebuild failures', async () => {
	setup({ targets: [sampleTargets[0]!], stageKey: null })
	mockModule.stagePublishedPackageArtifactRebuild.mockRejectedValue(
		new Error('staging kv unavailable'),
	)

	await expect(rebuild()).rejects.toThrow(/bundle artifact rebuild failed/i)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)

	// Memory/CPU isolate resets are deterministic for the same targets — do
	// not burn the transient platform-error retry budget on them (including
	// the D1-backed DO reset matcher that otherwise treats them as retryable).
	setup({ targets: [sampleTargets[0]!], stageKey: null })
	mockModule.stagePublishedPackageArtifactRebuild.mockRejectedValue(
		new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		),
	)
	await expect(rebuild()).rejects.toThrow(/bundle artifact rebuild failed/i)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
	expect(consoleWarn).not.toHaveBeenCalled()

	const run = vi.fn().mockResolvedValue({
		ok: false,
		message: 'No matching default export for import "default"',
	})
	setup({ targets: [sampleTargets[0]!], run })

	await expect(rebuild()).rejects.toThrow(/bundle artifact rebuild failed/i)
	expect(run).toHaveBeenCalledTimes(1)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
})

test('undeclared bare-import rebuild failures rehydrate as UserCodeError; declared stay platform Errors', async () => {
	const { isUserCodeError, UserCodeError } =
		await import('#worker/user-code-error.ts')
	const undeclaredMessage =
		'Saved package module "src/a.ts" bundle still contains unresolved bare package imports after bundling (bundle.js: "remix/data-schema"). Declare supported runtime dependencies in package.json and ensure checks/publish can resolve them before execution.'

	const callerRun = vi.fn(async (input: { targets: Array<Target> }) => ({
		ok: false,
		message: undeclaredMessage,
		results: input.targets.map((target) => ({
			ok: false,
			message: undeclaredMessage,
			callerFailure: true,
			target,
		})),
	}))
	setup({ targets: [sampleTargets[0]!], run: callerRun })
	await expect(rebuild()).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(UserCodeError)
		expect(isUserCodeError(error)).toBe(true)
		expect(String(error)).toMatch(/unresolved bare package imports/)
		return true
	})

	const platformRun = vi.fn(async (input: { targets: Array<Target> }) => ({
		ok: false,
		message: undeclaredMessage,
		results: input.targets.map((target) => ({
			ok: false,
			message: undeclaredMessage,
			target,
		})),
	}))
	setup({ targets: [sampleTargets[0]!], run: platformRun })
	await expect(rebuild()).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(UserCodeError)
		expect(isUserCodeError(error)).toBe(false)
		return true
	})
})

test('mixed caller and platform rebuild failures keep a platform cause for Sentry', async () => {
	const { isUserCodeError, UserCodeError } =
		await import('#worker/user-code-error.ts')
	const callerMessage =
		'Saved package module "src/a.ts" bundle still contains unresolved bare package imports after bundling (bundle.js: "remix/data-schema").'
	const platformMessage = 'KV PUT failed: 500 Internal Server Error'
	const run = vi.fn(async (input: { targets: Array<Target> }) => ({
		ok: false,
		message: 'mixed failures',
		results: input.targets.map((target, index) =>
			index === 0
				? {
						ok: false,
						message: callerMessage,
						callerFailure: true,
						target,
					}
				: {
						ok: false,
						message: platformMessage,
						target,
					},
		),
	}))
	setup({ targets: sampleTargets.slice(0, 2), run })
	await expect(rebuild()).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(UserCodeError)
		expect(isUserCodeError(error)).toBe(false)
		expect((error as Error).cause).toBeInstanceOf(Error)
		expect((error as Error).cause).not.toBeInstanceOf(UserCodeError)
		expect(String((error as Error).cause)).toContain(platformMessage)
		return true
	})
})

test('optional targets skip listing and only rebuild the supplied set', async () => {
	const selected = sampleTargets.slice(0, 2)
	const run = vi.fn(async (input: { targets: Array<Target> }) => ({
		ok: true,
		message: 'rebuilt',
		results: input.targets.map((target) => ({
			ok: true,
			message: 'rebuilt',
			target,
		})),
	}))
	setup({ run })
	await rebuild({ targets: selected })
	expect(mockModule.listPublishedPackageArtifactTargets).not.toHaveBeenCalled()
	expect(runTargets(run).flat()).toEqual(selected)
})
