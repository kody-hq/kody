import { expect, test } from 'vitest'
import {
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	createPackageSecretAccessDeniedBatchMessage,
	createSecretScopeUnavailableMessage,
} from '#mcp/secrets/errors.ts'
import {
	getSecretAuthorityScope,
	resolveCallerSecretAuthority,
	secretAuthorityArgName,
} from '#mcp/secrets/secret-authority.ts'
import { createKodyProviderProxySource } from '#mcp/kody-provider-proxy-source.ts'
import {
	kodyCallDispatcherName,
	kodyProviderEvaluateBindingName,
} from '#worker/kody-evaluate-bindings.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	ComputeOverageLimitError,
	EntitlementLimitError,
	JobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { createUnboundRuntimeHelperMessage } from '#worker/package-runtime/unbound-runtime-helpers.ts'
import { createStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import {
	createKodyRemoteProxy,
	createExecuteExecutor,
	createExecutorModuleSource,
	createExecutorSandboxTimeoutMessage,
	createNamedExecutionError,
	createToolDispatchers,
	formatExecutionOutput,
	getExecutionErrorDetails,
	limitExecutionResultValue,
	runWithDynamicWorkerEvaluationBudget,
	type ClaimWorkerDayAttribution,
	createSandboxRecordFetchAttemptSource,
} from './executor.ts'
import {
	durableObjectCodeUpdatedResetMessage,
	executorSandboxTimeoutMessage,
} from '#worker/sentry-options.ts'
import { workersHungExecutionMessage } from '@kody-internal/shared/workers-hung-request.ts'
import { assertGeneratedExecutorSourceIsBundleSafe } from './kody-remote-proxy-source.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { createEvaluationSideEffectTracker } from '#mcp/evaluation-side-effects.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
type FakeWorkerOptions = Record<string, unknown>
type Dispatchers = Record<string, { call: typeof ToolDispatcherCall }>
type ExecutorInput = Parameters<typeof createExecuteExecutor>[0]
type ExecuteArgs = Parameters<
	ReturnType<typeof createExecuteExecutor>['execute']
>

function createFakeWorkerLoader() {
	const ids: Array<string> = []
	const createdOptions = new Map<string, FakeWorkerOptions>()
	const evaluations: Array<{
		dispatchers: Dispatchers
		invocation: unknown
		runFetcher: unknown
	}> = []
	let factoryCallCount = 0
	const loader = {
		get(id: string, factory: () => FakeWorkerOptions) {
			ids.push(id)
			let options = createdOptions.get(id)
			if (!options) {
				factoryCallCount += 1
				options = factory()
				createdOptions.set(id, options)
			}
			return {
				getEntrypoint() {
					return {
						async evaluate(
							dispatchers: Dispatchers,
							invocation?: unknown,
							_packageBindings?: unknown,
							runFetcher?: unknown,
						) {
							evaluations.push({ dispatchers, invocation, runFetcher })
							return { result: id, logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
	return {
		loader,
		ids,
		createdOptions,
		evaluations,
		get factoryCallCount() {
			return factoryCallCount
		},
		get stats() {
			return {
				loads: ids.length,
				uniqueIds: new Set(ids).size,
				factoryCalls: factoryCallCount,
			}
		},
	}
}

function createEvaluateLoader(
	evaluate: (dispatchers: Dispatchers) => Promise<unknown>,
) {
	return {
		get(_id: string, factory: () => FakeWorkerOptions) {
			factory()
			return { getEntrypoint: () => ({ evaluate }) }
		},
	} as unknown as Env['LOADER']
}

async function ToolDispatcherCall(_name: string, _argsJson: string) {
	return ''
}

function createExecutorTestEnv(
	loader: Env['LOADER'],
	extra: Record<string, unknown> = {},
) {
	return { LOADER: loader, APP_COMMIT_SHA: 'commit-for-test', ...extra } as Env
}

function createExecutorTestExports() {
	return {
		KodyFetchGateway: ({ props }: { props: unknown }) => ({ props }),
	} as never
}

function createGatewayProps(
	userId: string,
	overrides?: {
		email?: string | null
		storageContext?: StorageContext | null
	},
) {
	return {
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored(userId),
		email: overrides?.email ?? `${userId}@example.com`,
		request: null,
		storageContext:
			overrides?.storageContext === undefined ? null : overrides.storageContext,
	}
}

function runExecutor(
	input: Omit<ExecutorInput, 'gatewayProps'> & {
		gatewayProps?: ExecutorInput['gatewayProps']
	},
	code = 'async () => "ok"',
	providers: ExecuteArgs[1] = [{ name: 'kody', fns: {} }],
	invocation?: ExecuteArgs[2],
) {
	return createExecuteExecutor({
		exports: createExecutorTestExports(),
		gatewayProps: createGatewayProps('user-1'),
		...input,
	}).execute(code, providers, invocation)
}

function createUsageBindings({ meter = false } = {}) {
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const rollupWrites: Array<Array<unknown>> = []
	const activationStampWrites: Array<string> = []
	const bindings = {
		...(meter ? createInMemoryUserMeterEnv().env : {}),
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
		APP_DB: {
			prepare(sql: string) {
				return {
					bind(...args: Array<unknown>) {
						return {
							async run() {
								if (sql.includes('usage_rollups')) rollupWrites.push(args)
								if (sql.includes('first_execute_at')) {
									activationStampWrites.push(sql)
								}
								return {}
							},
						}
					},
				}
			},
		},
	}
	return { bindings, dataPoints, rollupWrites, activationStampWrites }
}

const notConnected = (name: string) =>
	`The MCP server "${name}" is not connected. Kody cannot use this server until it reconnects.`

function mcpServerEntry(
	name: string,
	connected: boolean,
	toolNames: Array<string>,
) {
	return {
		name,
		status: connected
			? {
					state: 'connected' as const,
					connected,
					toolCount: toolNames.length,
					message: `The MCP server "${name}" is connected.`,
					unavailableMessage: `The MCP server "${name}" is connected.`,
				}
			: {
					state: 'disconnected' as const,
					connected,
					toolCount: 0,
					message: `The MCP server "${name}" is not connected.`,
					unavailableMessage: notConnected(name),
				},
		capabilities: toolNames.map((tool) => ({
			name: tool,
			dispatchName: `mcp${name}${tool}`,
		})),
	}
}

function createMcpProxy(
	entries: Array<ReturnType<typeof mcpServerEntry>>,
	callTool: (dispatchName: string, args: unknown) => Promise<unknown>,
) {
	return createKodyRemoteProxy({
		entries,
		entityLabel: 'MCP server',
		shortEntityLabel: 'MCP server',
		capabilityLabel: 'MCP tool',
		callTool,
	}) as Record<string, Record<string, (args: unknown) => Promise<unknown>>>
}

test('kody namespaced proxy dispatches, enumerates tools, and reports entry/capability errors clearly', async () => {
	const calls: Array<{ dispatchName: string; args: unknown }> = []
	const mcp = createMcpProxy(
		[
			mcpServerEntry('home', true, ['set_pin']),
			mcpServerEntry('lights', false, []),
		],
		async (dispatchName, args) => {
			calls.push({ dispatchName, args })
			return { ok: true }
		},
	)

	await expect(mcp['home']?.set_pin?.({ pin: '1234' })).resolves.toEqual({
		ok: true,
	})
	expect(calls).toEqual([
		{ dispatchName: 'mcphomeset_pin', args: { pin: '1234' } },
	])
	for (const name of ['missing', 'toString', 'constructor']) {
		expect(() => mcp[name]).toThrow(
			`Unknown MCP server "${name}". Available MCP servers: "home", "lights".`,
		)
	}
	expect(() => mcp['home']?.missing_tool).toThrow(
		'Unknown MCP tool "missing_tool" for MCP server "home". Available capabilities: "set_pin".',
	)
	expect(() => mcp['lights']?.set_pin).toThrow(notConnected('lights'))

	expect('home' in mcp).toBe(true)
	expect(Object.keys(mcp).sort()).toEqual(['home', 'lights'])
	const { home } = mcp
	if (!home) throw new Error('Expected home MCP server proxy')
	await expect(home.set_pin?.({ pin: '9999' })).resolves.toEqual({ ok: true })
	expect(Object.keys(home)).toEqual(['set_pin'])
	expect(() => {
		const { missing_tool } = home
		return missing_tool
	}).toThrow(
		'Unknown MCP tool "missing_tool" for MCP server "home". Available capabilities: "set_pin".',
	)

	// Disconnected servers still enumerate advertised tools but never dispatch.
	const disconnected = createMcpProxy(
		[mcpServerEntry('home', false, ['sonos_list_players'])],
		async () => {
			throw new Error('disconnected servers must not dispatch')
		},
	)
	const disconnectedHome = disconnected.home
	if (!disconnectedHome) throw new Error('Expected home MCP server proxy')
	expect(Object.keys(disconnectedHome)).toEqual(['sonos_list_players'])
	expect(Object.entries(disconnectedHome).map(([name]) => name)).toEqual([
		'sonos_list_players',
	])
	await expect(disconnectedHome.sonos_list_players?.({})).rejects.toThrow(
		notConnected('home'),
	)
})

test('generated kody provider and executor module sources stay bundle-safe and gate outbound fetch', async () => {
	assertGeneratedExecutorSourceIsBundleSafe(
		createKodyProviderProxySource({ providerName: 'kody' }),
	)
	const moduleSourceFor = (
		options: Partial<Parameters<typeof createExecutorModuleSource>[0]> = {},
	) =>
		createExecutorModuleSource({
			code: 'async () => "ok"',
			providers: [{ name: 'kody', fns: {} }],
			shadowGlobalThis: false,
			timeoutMs: 1_000,
			...options,
		})

	const moduleSource = await moduleSourceFor()
	assertGeneratedExecutorSourceIsBundleSafe(moduleSource)
	const expectedSnippets = [
		'from "node:async_hooks"',
		'__kodyEvaluateFetchStorage.run',
		'.call("recordFetch", "[]")',
		'if (hostname && hostname !== __kodyExcludedFetchHost)',
		'const __kodyMcp =',
		'getOwnPropertyDescriptor',
		'async evaluate(__dispatchers = {}, __invocation = {}, __kodyPackageBindingStubs = null, __kodyRunFetcher = null)',
		'const __kodyPackageBindings = __kodyCreateSandboxPackageBindings(',
		')(__invocation)',
		'__invocation.mcpServers',
		`const ${kodyProviderEvaluateBindingName} = new Proxy`,
		`const ${kodyCallDispatcherName} = async`,
	]
	expect(expectedSnippets.filter((s) => !moduleSource.includes(s))).toEqual([])
	// GHSA-5fv3: package identity is a trusted per-package binding, never an
	// ambient getter or a header the sandbox sets.
	expect(moduleSource).not.toContain('kody.getSecretAuthority')
	expect(moduleSource).not.toContain('__kodyGetSecretAuthority')
	expect(moduleSource).not.toMatch(/headers\.set\([^)]*x-kody-secret-authority/)
	expect(moduleSource).not.toMatch(/\b(?:const|let|var) kody\b/)
	expect(moduleSource).not.toContain(
		`async (globalThis, self, global, ${kodyCallDispatcherName}`,
	)

	expect(await moduleSourceFor({ shadowGlobalThis: true })).toContain(
		`async (globalThis, self, global, __kodyPackageBindings, __kodyPackageBindingStubs, __kodyPackageMcpFactoryRef, ${kodyCallDispatcherName}, ${kodyProviderEvaluateBindingName}, __kodyMcp, __kodyCreateRemoteProxy, __dispatchers) => (`,
	)
})

test('generated kody provider source wires mcp proxy dispatch', async () => {
	const calls: Array<{ name: string; argsJson: string }> = []
	const source = createKodyProviderProxySource({ providerName: 'kody' })
	const authoritySymbol = Symbol.for('kody.getSecretAuthority')
	Object.defineProperty(globalThis, authoritySymbol, {
		value: () => 'pkg-stamped',
		configurable: true,
		writable: true,
	})
	try {
		const kody = new Function(
			'__dispatchers',
			'__invocation',
			`${source}; return ${kodyProviderEvaluateBindingName};`,
		)(
			{
				kody: {
					async call(name: string, argsJson: string) {
						calls.push({ name, argsJson })
						return JSON.stringify({ result: { ok: true } })
					},
				},
			},
			{
				mcpServers: [
					{
						name: 'home',
						status: {
							connected: true,
							toolCount: 1,
							unavailableMessage: 'The MCP server "home" is connected.',
						},
						capabilities: [{ name: 'set_pin', dispatchName: 'mcphomeset_pin' }],
					},
				],
			},
		) as {
			mcp: Record<string, Record<string, (args?: unknown) => Promise<unknown>>>
			[key: string]: unknown
		}

		await expect(kody.mcp['home']?.set_pin?.({ pin: '1234' })).resolves.toEqual(
			{ ok: true },
		)
		// GHSA-5fv3: a planted Symbol.for getter is ignored; generic
		// dispatch carries no authority field (the host binds identity).
		expect(calls).toEqual([
			{
				name: 'mcphomeset_pin',
				argsJson: JSON.stringify({ pin: '1234' }),
			},
		])
		calls.length = 0
		await expect(
			kody.mcp['home']?.set_pin?.({
				pin: '1',
				__kodySecretAuthorityPackageId: 'pkg-forged',
			}),
		).resolves.toEqual({ ok: true })
		expect(calls).toEqual([
			{ name: 'mcphomeset_pin', argsJson: JSON.stringify({ pin: '1' }) },
		])
		calls.length = 0
		await expect(kody.mcp['home']?.set_pin?.()).resolves.toEqual({ ok: true })
		expect(calls).toEqual([
			{ name: 'mcphomeset_pin', argsJson: JSON.stringify({}) },
		])
		expect(() => kody['mcp:home:set_pin']).toThrow(
			'MCP server tool "mcp:home:set_pin" is not available as a flat kody function.',
		)
		expect('mcp' in kody).toBe(true)
		const { home } = kody.mcp
		if (!home) throw new Error('Expected home MCP server proxy')
		await expect(home.set_pin?.({ pin: '5678' })).resolves.toEqual({
			ok: true,
		})
		expect(() => kody.mcp['missing']).toThrow(
			'Unknown MCP server "missing". Available MCP servers: "home".',
		)
	} finally {
		delete (globalThis as unknown as Record<symbol, unknown>)[authoritySymbol]
	}
})

test('createExecuteExecutor aligns worker compatibility and leaves the fetch deadline to the gateway', async () => {
	const readWorkerOptions = async (timeoutMs?: number | null) => {
		const fakeLoader = createFakeWorkerLoader()
		await runExecutor({
			env: createExecutorTestEnv(fakeLoader.loader),
			timeoutMs,
		})
		const options = fakeLoader.createdOptions.get(fakeLoader.ids[0]!)
		if (!options) throw new Error('Expected worker options')
		const runFetcher = fakeLoader.evaluations[0]?.runFetcher
		return { options, runFetcher }
	}

	expect((await readWorkerOptions()).options).toMatchObject(
		createDynamicWorkerCompatibilityOptions(),
	)
	for (const timeoutMs of [undefined, 300_000, null]) {
		const { options, runFetcher } = await readWorkerOptions(timeoutMs)
		expect(
			(options['globalOutbound'] as { props?: object } | undefined)?.props,
		).toEqual({})
		const gatewayProps = (runFetcher as { props?: object } | undefined)?.props
		expect(gatewayProps).not.toHaveProperty('allowOutboundFetch')
		expect(gatewayProps).not.toHaveProperty('outboundFetchTimeoutMs')
	}
})

test('explicit request budgets cap independent roots at four without blocking separate requests', async () => {
	const createBudgetState = () => {
		const state = {
			active: 0,
			maxActive: 0,
			started: 0,
			releases: [] as Array<() => void>,
		}
		const loader = createEvaluateLoader(async () => {
			state.started += 1
			state.active += 1
			state.maxActive = Math.max(state.maxActive, state.active)
			await new Promise<void>((resolve) => {
				state.releases.push(() => {
					state.active -= 1
					resolve()
				})
			})
			return { result: 'done', logs: [] }
		})
		return { state, loader }
	}
	const runFiveRoots = (
		userId: string,
		{ loader }: ReturnType<typeof createBudgetState>,
	) =>
		runWithDynamicWorkerEvaluationBudget(
			async () =>
				await Promise.all(
					Array.from({ length: 5 }, (_, index) =>
						runExecutor(
							{
								env: createExecutorTestEnv(loader),
								gatewayProps: createGatewayProps(userId),
							},
							`async () => ${index}`,
						),
					),
				),
		)

	const first = createBudgetState()
	const firstRequest = runFiveRoots('first-request-user', first)
	await expect.poll(() => first.state.started).toBe(4)
	expect(first.state).toMatchObject({ active: 4, maxActive: 4 })

	const second = createBudgetState()
	const secondRequest = runFiveRoots('second-request-user', second)
	await expect.poll(() => second.state.started).toBe(4)
	expect(second.state).toMatchObject({ active: 4, maxActive: 4 })

	first.state.releases.shift()?.()
	second.state.releases.shift()?.()
	await expect.poll(() => first.state.started).toBe(5)
	await expect.poll(() => second.state.started).toBe(5)
	expect(first.state.active).toBe(4)
	expect(second.state.active).toBe(4)

	for (const release of first.state.releases.splice(0)) release()
	for (const release of second.state.releases.splice(0)) release()
	await expect(firstRequest).resolves.toHaveLength(5)
	await expect(secondRequest).resolves.toHaveLength(5)
	expect(first.state.active).toBe(0)
	expect(second.state.active).toBe(0)
})

test('createExecuteExecutor enforces the host timeout: hang, late settle, abort-aware dispatch, and queued evaluations', async () => {
	// A hanging evaluate returns the sandbox timeout promptly.
	const startedAtMs = Date.now()
	const hung = await runExecutor({
		env: createExecutorTestEnv(
			createEvaluateLoader(async () => await new Promise(() => {})),
		),
		gatewayProps: createGatewayProps('hang-user'),
		timeoutMs: 40,
	})
	expect(hung.error).toBe(createExecutorSandboxTimeoutMessage(40))
	expect(hung.error).toContain('Execution timed out after 40ms:')
	expect(hung.result).toBeUndefined()
	expect(Date.now() - startedAtMs).toBeLessThan(500)

	// Logs from an evaluation that settles just after the timeout are drained.
	const timeoutMessage = createExecutorSandboxTimeoutMessage(20)
	const late = await runExecutor({
		env: createExecutorTestEnv(
			createEvaluateLoader(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40))
				return {
					result: undefined,
					error: timeoutMessage,
					logs: ['started context lookup'],
				}
			}),
		),
		gatewayProps: createGatewayProps('drain-user'),
		timeoutMs: 20,
	})
	expect(late).toEqual({
		result: undefined,
		error: timeoutMessage,
		logs: ['started context lookup'],
		hostMediatedSideEffects: { dispatcherAttempts: 0, fetchAttempts: 0 },
	})
	expect(createNamedExecutionError(late.error).name).toBe('TimeoutError')

	// An in-flight abort-aware dispatcher is aborted.
	let observedSignal: AbortSignal | undefined
	const aborted = await runExecutor(
		{
			env: createExecutorTestEnv(
				createEvaluateLoader(async (dispatchers) => {
					await dispatchers['packageBridge']?.call(
						'invoke',
						JSON.stringify([{}]),
					)
					return { result: 'unexpected', logs: [] }
				}),
			),
			gatewayProps: createGatewayProps('abort-user'),
			timeoutMs: 40,
		},
		'async () => "never"',
		[
			{
				name: 'packageBridge',
				fns: {
					invoke: async (_input: unknown, signal?: AbortSignal) => {
						observedSignal = signal
						await new Promise<never>((_resolve, reject) => {
							signal?.addEventListener('abort', () => reject(signal.reason), {
								once: true,
							})
						})
					},
				},
				abortSignalToolNames: ['invoke'],
			} as never,
		],
	)
	expect(aborted.error).toBe(createExecutorSandboxTimeoutMessage(40))
	expect(observedSignal?.aborted).toBe(true)

	// Queued evaluations are dropped once their host deadline expires.
	let evaluateStarts = 0
	let releaseHolders: () => void = () => {}
	const holdersMayFinish = new Promise<void>((resolve) => {
		releaseHolders = resolve
	})
	let resolveAllHoldersStarted: () => void = () => {}
	const allHoldersStarted = new Promise<void>((resolve) => {
		resolveAllHoldersStarted = resolve
	})
	const sharedEnv = createExecutorTestEnv(
		createEvaluateLoader(async () => {
			evaluateStarts += 1
			if (evaluateStarts === 4) resolveAllHoldersStarted()
			await holdersMayFinish
			return { result: 'done', logs: [] }
		}),
	)
	const queueUser = createGatewayProps('queue-user')
	await runWithDynamicWorkerEvaluationBudget(async () => {
		const holders = Array.from({ length: 4 }, () =>
			runExecutor(
				{ env: sharedEnv, gatewayProps: queueUser, timeoutMs: 10_000 },
				'async () => "holder"',
			),
		)
		await allHoldersStarted
		expect(evaluateStarts).toBe(4)

		const queuedResult = await runExecutor(
			{ env: sharedEnv, gatewayProps: queueUser, timeoutMs: 40 },
			'async () => "queued"',
		)
		expect(queuedResult.error).toBe(createExecutorSandboxTimeoutMessage(40))
		expect(evaluateStarts).toBe(4)

		releaseHolders()
		await Promise.all(holders)
		expect(evaluateStarts).toBe(4)
	})
})

test('createExecuteExecutor reuses stable dynamic worker ids until binding context or module graph changes', async () => {
	const statsFor = (loads: number, uniqueIds: number) => ({
		loads,
		uniqueIds,
		factoryCalls: uniqueIds,
	})
	const fakeLoader = createFakeWorkerLoader()
	const env = createExecutorTestEnv(fakeLoader.loader)

	const first = await runExecutor({ env }, 'async () => "ok"', [
		{ name: 'kody', fns: { search: async () => ({ ok: true }) } },
	])
	const second = await runExecutor(
		{
			env,
			gatewayProps: createGatewayProps('user-1', {
				email: 'other-address@example.com',
			}),
		},
		'async () => "ok"',
		[
			{
				name: 'kody',
				fns: {
					search: async () => ({ ok: 'different dispatcher same worker' }),
				},
			},
		],
	)
	expect(first.result).toBe(second.result)
	expect(fakeLoader.stats).toEqual(statsFor(2, 1))

	for (const [userId, value] of [
		['user-1', 'one'],
		['user-2', 'one'],
		['user-1', 'two'],
	] as const) {
		await runExecutor({
			env,
			gatewayProps: createGatewayProps(userId),
			modules: { 'helper.js': `export const value = "${value}";` },
		})
	}
	expect(fakeLoader.stats).toEqual(statsFor(5, 4))

	const noUserLoader = createFakeWorkerLoader()
	for (let index = 0; index < 2; index += 1) {
		await runExecutor({
			env: createExecutorTestEnv(noUserLoader.loader),
			gatewayProps: { ...createGatewayProps('user-1'), userId: null },
		})
	}
	expect(noUserLoader.stats).toEqual(statsFor(2, 1))

	const commitShaLoader = createFakeWorkerLoader()
	for (const commitSha of ['commit-aaa', 'commit-bbb', undefined]) {
		await runExecutor({
			env: createExecutorTestEnv(commitShaLoader.loader, {
				APP_COMMIT_SHA: commitSha,
			}),
		})
	}
	expect(commitShaLoader.stats).toEqual(statsFor(3, 1))

	const entryModules = {
		'entry.js': 'export default async function main() { return "ok" }',
	}
	const bundledRuns: Array<
		[string, Array<Partial<ExecutorInput>>, ReturnType<typeof statsFor>]
	> = [
		['same bundled graph', [{}, {}], statsFor(2, 1)],
		[
			'different user',
			[{}, { gatewayProps: createGatewayProps('user-2') }],
			statsFor(2, 2),
		],
		[
			'different storage context',
			[
				{},
				{
					gatewayProps: createGatewayProps('user-1', {
						storageContext: {
							sessionId: 'session-1',
							appId: 'app-1',
							storageId: 'storage-1',
						},
					}),
				},
			],
			statsFor(2, 2),
		],
		[
			'binary module bytes',
			[
				{
					modules: {
						...entryModules,
						'lib.wasm': { wasm: new Uint8Array([0, 97, 115, 109]) },
					} as never,
				},
				{
					modules: {
						...entryModules,
						'lib.wasm': { wasm: new Uint8Array([0, 97, 115, 109]) },
					} as never,
				},
			],
			statsFor(2, 1),
		],
	]
	const bundledStats = []
	for (const [label, runs] of bundledRuns) {
		const loader = createFakeWorkerLoader()
		for (const run of runs) {
			await runExecutor({
				env: createExecutorTestEnv(loader.loader),
				modules: entryModules,
				...run,
			})
		}
		bundledStats.push([label, loader.stats])
	}
	expect(bundledStats).toEqual(
		bundledRuns.map(([label, , stats]) => [label, stats]),
	)

	const invocationLoader = createFakeWorkerLoader()
	const invocationEnv = createExecutorTestEnv(invocationLoader.loader)
	const invocationCode = 'async (__invocation = {}) => __invocation.params'
	const invocations = [
		{ params: { room: 'office' } },
		{ params: { room: 'kitchen' } },
		{
			params: { room: 'office' },
			packageContext: { packageId: 'pkg-1', kodyId: 'bot' },
		},
	] as const
	for (const invocation of invocations) {
		await runExecutor(
			{ env: invocationEnv },
			invocationCode,
			undefined,
			invocation,
		)
	}
	expect(invocationLoader.stats).toEqual(statsFor(3, 1))
	expect(invocationLoader.evaluations.map((entry) => entry.invocation)).toEqual(
		[
			{ params: { room: 'office' }, packageContext: null, mcpServers: [] },
			{ params: { room: 'kitchen' }, packageContext: null, mcpServers: [] },
			{
				params: { room: 'office' },
				packageContext: { packageId: 'pkg-1', kodyId: 'bot' },
				mcpServers: [],
			},
		],
	)

	const otherCode = await runExecutor(
		{ env: invocationEnv },
		'async () => "other"',
	)
	expect(otherCode.result).not.toBe(invocationLoader.ids[0])
	expect(new Set(invocationLoader.ids).size).toBe(2)

	const mcpStatusLoader = createFakeWorkerLoader()
	const mcpStatusEnv = createExecutorTestEnv(mcpStatusLoader.loader)
	for (const connected of [true, false]) {
		await runExecutor({ env: mcpStatusEnv }, invocationCode, [
			{
				name: 'kody',
				fns: {},
				kodyMcpServers: [
					{
						...mcpServerEntry('home', connected, ['set_pin']),
						serverId: 'home',
					},
				],
			} as never,
		])
	}
	expect(mcpStatusLoader.stats).toEqual(statsFor(2, 1))
	const capabilities = [{ name: 'set_pin', dispatchName: 'mcphomeset_pin' }]
	expect(mcpStatusLoader.evaluations.map((entry) => entry.invocation)).toEqual([
		{
			params: undefined,
			packageContext: null,
			mcpServers: [
				{
					name: 'home',
					status: {
						connected: true,
						toolCount: 1,
						unavailableMessage: 'The MCP server "home" is connected.',
					},
					capabilities,
				},
			],
		},
		{
			params: undefined,
			packageContext: null,
			mcpServers: [
				{
					name: 'home',
					status: {
						connected: false,
						toolCount: 0,
						unavailableMessage: notConnected('home'),
					},
					capabilities,
				},
			],
		},
	])
})

test('createExecuteExecutor records one usage event per sandbox run with duration and outcome', async () => {
	const { bindings, dataPoints, rollupWrites, activationStampWrites } =
		createUsageBindings()
	const envWith = (loader: Env['LOADER']) =>
		createExecutorTestEnv(loader, bindings)
	const usageUser = createGatewayProps('usage-user-1')

	// Successful sandbox run: one success event.
	await runExecutor({
		env: envWith(createFakeWorkerLoader().loader),
		gatewayProps: usageUser,
	})
	expect(dataPoints).toHaveLength(1)
	expect(dataPoints[0]?.indexes).toEqual(['usage-user-1'])
	expect(dataPoints[0]?.blobs?.slice(0, 4)).toEqual([
		'usage-user-1',
		'execute',
		'',
		'success',
	])
	expect(dataPoints[0]?.doubles?.[0]).toBeGreaterThanOrEqual(0)
	// With USAGE_EVENTS present, rollups are derived from Analytics Engine
	// by the scheduled aggregation instead of a per-event D1 upsert.
	expect(rollupWrites).toHaveLength(0)
	// Activation first-seen stamps still write to D1 (write-once COALESCE).
	expect(activationStampWrites).toHaveLength(1)

	// Sandbox run returning an error result: one error event.
	const errorResult = await runExecutor({
		env: envWith(
			createEvaluateLoader(async () => ({
				result: undefined,
				error: 'boom',
				logs: [],
			})),
		),
		gatewayProps: usageUser,
	})
	expect(errorResult.error).toBe('boom')
	expect(dataPoints).toHaveLength(2)
	expect(dataPoints[1]?.blobs?.[3]).toBe('error')

	// Loader throwing: error event recorded, original error rethrown.
	const throwingLoader = {
		get() {
			throw new Error('loader unavailable')
		},
	} as unknown as Env['LOADER']
	await expect(
		runExecutor({ env: envWith(throwingLoader), gatewayProps: usageUser }),
	).rejects.toThrow('loader unavailable')
	expect(dataPoints).toHaveLength(3)
	expect(dataPoints[2]?.blobs?.[3]).toBe('error')

	// No signed-in user: nothing recorded.
	await runExecutor({
		env: envWith(createFakeWorkerLoader().loader),
		gatewayProps: { ...usageUser, userId: null },
	})
	expect(dataPoints).toHaveLength(3)

	// Provider validation failure never reaches the sandbox: nothing recorded.
	const validationResult = await runExecutor(
		{ env: envWith(createFakeWorkerLoader().loader), gatewayProps: usageUser },
		'async () => "ok"',
		[{ name: 'class', fns: {} }],
	)
	expect(validationResult.error).toContain('reserved')
	expect(dataPoints).toHaveLength(3)

	// Nested surfaces (jobs, package exports) opt out so they do not inflate
	// the execute-tool metric or stamp first_execute_at.
	await runExecutor({
		env: envWith(createFakeWorkerLoader().loader),
		gatewayProps: usageUser,
		recordExecuteUsage: false,
	})
	expect(dataPoints).toHaveLength(3)
	expect(activationStampWrites).toHaveLength(1)
	expect(rollupWrites).toHaveLength(0)
})

test('createExecuteExecutor records one unique Dynamic Worker day per worker id and defers it with the first-execute stamp via waitUntil', async () => {
	const perWorker = createUsageBindings({ meter: true })
	for (let run = 0; run < 2; run += 1) {
		await runExecutor({
			env: createExecutorTestEnv(
				createFakeWorkerLoader().loader,
				perWorker.bindings,
			),
			gatewayProps: createGatewayProps('usage-user-dw'),
			recordExecuteUsage: false,
		})
	}
	const { dataPoints } = perWorker
	expect(dataPoints.map((point) => point.blobs?.[1])).toEqual([
		'dynamic_worker_day',
		'dynamic_worker_invoke',
		'dynamic_worker_invoke',
	])
	expect(dataPoints[0]?.indexes).toEqual(['usage-user-dw'])
	expect(dataPoints[0]?.blobs?.[5]).toBe('execute')
	expect(dataPoints[1]?.blobs?.[7]).toBe('miss')
	expect(dataPoints[2]?.blobs?.[7]).toBe('hit')

	const deferred = createUsageBindings({ meter: true })
	const waitUntilTasks: Array<Promise<unknown>> = []
	const result = await runExecutor({
		env: createExecutorTestEnv(
			createFakeWorkerLoader().loader,
			deferred.bindings,
		),
		gatewayProps: createGatewayProps('usage-user-waituntil'),
		waitUntil: (promise: Promise<unknown>) => {
			waitUntilTasks.push(promise)
		},
	})
	expect(result.error).toBeUndefined()
	expect(waitUntilTasks.length).toBeGreaterThanOrEqual(2)
	await Promise.all(waitUntilTasks)
	expect(deferred.activationStampWrites).toHaveLength(1)
	expect(deferred.dataPoints.map((point) => point.blobs?.[1]).sort()).toEqual([
		'dynamic_worker_day',
		'dynamic_worker_invoke',
		'execute',
	])
})

test('createExecuteExecutor awaits a capped worker-day claim before load and skips the attribution claim', async () => {
	const usage = createUsageBindings({ meter: true })
	const claimed: Array<string> = []
	const attributions: Array<ClaimWorkerDayAttribution> = []
	const allowedLoader = createFakeWorkerLoader()
	const allowed = await runExecutor({
		env: createExecutorTestEnv(allowedLoader.loader, usage.bindings),
		recordExecuteUsage: false,
		packageId: 'pkg-1',
		claimWorkerDay: async (workerId, attribution) => {
			claimed.push(workerId)
			attributions.push(attribution)
			expect(allowedLoader.ids).toEqual([])
			return { created: true }
		},
	})
	expect(allowed.error).toBeUndefined()
	expect(allowedLoader.ids).toEqual(claimed)
	expect(attributions).toEqual([{ packageId: 'pkg-1' }])
	expect(usage.dataPoints.map((point) => point.blobs?.[1])).toEqual([
		'dynamic_worker_invoke',
	])
	expect(usage.dataPoints[0]?.blobs?.[7]).toBe('miss')

	const deniedLoader = createFakeWorkerLoader()
	const denial = new Error('Plan limit reached')
	await expect(
		runExecutor({
			env: createExecutorTestEnv(deniedLoader.loader, usage.bindings),
			claimWorkerDay: async () => {
				throw denial
			},
		}),
	).rejects.toBe(denial)
	expect(deniedLoader.ids).toEqual([])
})

test('createExecuteExecutor rejects reserved provider names, keeps side-effect counts on DO reset, and disables dispatchers after completion', async () => {
	const fakeLoader = createFakeWorkerLoader()
	for (const name of ['class', 'private']) {
		const result = await runExecutor(
			{ env: createExecutorTestEnv(fakeLoader.loader) },
			'async () => "ok"',
			[{ name, fns: {} }],
		)
		expect(result).toEqual({
			result: undefined,
			error: `Provider name "${name}" is a JavaScript reserved word`,
			hostMediatedSideEffects: { dispatcherAttempts: 0, fetchAttempts: 0 },
		})
	}
	expect(fakeLoader.factoryCallCount).toBe(0)

	const searchProvider = [
		{ name: 'kody', fns: { search: async () => ({ ok: true }) } },
	]
	const reset = await runExecutor(
		{
			env: createExecutorTestEnv(
				createEvaluateLoader(async (dispatchers) => {
					await dispatchers.kody?.call('search', '{}')
					throw new Error(durableObjectCodeUpdatedResetMessage)
				}),
			),
			gatewayProps: createGatewayProps('reset-user'),
		},
		'async () => "ok"',
		searchProvider,
	)
	expect(reset).toEqual({
		result: undefined,
		error: durableObjectCodeUpdatedResetMessage,
		logs: [],
		hostMediatedSideEffects: { dispatcherAttempts: 1, fetchAttempts: 0 },
	})

	const workersHungMessage =
		"The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response. Refer to: https://developers.cloudflare.com/workers/observability/errors/"
	const hungCancel = await runExecutor({
		env: createExecutorTestEnv(
			createEvaluateLoader(async () => {
				throw new Error(workersHungMessage)
			}),
		),
		gatewayProps: createGatewayProps('hung-cancel-user'),
	})
	expect(hungCancel).toEqual({
		result: undefined,
		error: workersHungExecutionMessage,
		logs: [],
		hostMediatedSideEffects: { dispatcherAttempts: 0, fetchAttempts: 0 },
	})
	expect(hungCancel.error).not.toContain('Workers runtime canceled')
	expect(hungCancel.error).not.toContain('Scheduled job')

	await runExecutor(
		{ env: createExecutorTestEnv(fakeLoader.loader) },
		'async () => await kody.search({ q: "ok" })',
		searchProvider,
	)
	const dispatchers = fakeLoader.evaluations[0]?.dispatchers
	const afterCompletion = await dispatchers?.kody?.call('search', '{}')
	expect(JSON.parse(afterCompletion ?? '{}')).toEqual({
		error: 'Execution has already completed.',
	})
})

test('createToolDispatchers restores secret-authority grants after an ALS gap', async () => {
	// Same Workers-RPC ALS drop as evaluation-budget restore: ambient
	// runWithSecretAuthorityScope around evaluate does not survive into
	// ToolDispatcher.call. Grants must be captured into createToolDispatchers.
	const parseCall = async (result: Promise<string | undefined>) =>
		JSON.parse((await result) ?? '{}') as {
			result?: unknown
			error?: string
		}

	const granted = new Set(['pkg-approved'])
	let seenAuthority: string | null | undefined
	let seenGrantSize: number | undefined
	const dispatchers = createToolDispatchers(
		[
			{
				name: 'kody',
				fns: {
					probe: async () => {
						const scope = getSecretAuthorityScope()
						seenGrantSize = scope?.grantedPackageIds.size
						seenAuthority = resolveCallerSecretAuthority({
							storageContext: {
								sessionId: null,
								appId: null,
								packageId: null,
								storageId: null,
							},
						}).authorityPackageId
						return { authority: seenAuthority }
					},
				},
			},
		],
		{ active: true },
		undefined,
		undefined,
		granted,
	)
	const kodyDispatcher = dispatchers.kody
	if (!kodyDispatcher) throw new Error('Expected kody dispatcher')

	expect(getSecretAuthorityScope()).toBeNull()
	// GHSA-5fv3: the generic dispatcher ignores a sandbox-supplied
	// authority field, even a granted id, but still restores the grant set.
	const forgedGranted = await parseCall(
		kodyDispatcher.call(
			'probe',
			JSON.stringify({ [secretAuthorityArgName]: 'pkg-approved' }),
		),
	)
	expect(forgedGranted).toEqual({ result: { authority: null } })
	expect(seenGrantSize).toBe(1)
	expect(getSecretAuthorityScope()).toBeNull()

	const forged = await parseCall(
		kodyDispatcher.call(
			'probe',
			JSON.stringify({ [secretAuthorityArgName]: 'pkg-forged' }),
		),
	)
	expect(forged).toEqual({ result: { authority: null } })

	// The trusted per-package binding carries the authority host-side.
	const boundDispatcher = createToolDispatchers(
		[
			{
				name: 'kody',
				fns: {
					probe: async () => {
						const scope = getSecretAuthorityScope()
						seenGrantSize = scope?.grantedPackageIds.size
						return {
							authority: resolveCallerSecretAuthority({
								storageContext: {
									sessionId: null,
									appId: null,
									packageId: null,
									storageId: null,
								},
							}).authorityPackageId,
						}
					},
				},
			},
		],
		{ active: true },
		undefined,
		undefined,
		granted,
		{ boundPackageId: 'pkg-approved' },
	).kody
	if (!boundDispatcher) throw new Error('Expected bound kody dispatcher')
	const bound = await parseCall(
		boundDispatcher.call(
			'probe',
			JSON.stringify({ [secretAuthorityArgName]: 'pkg-forged' }),
		),
	)
	expect(bound).toEqual({ result: { authority: 'pkg-approved' } })
	expect(seenGrantSize).toBe(1)
	expect(getSecretAuthorityScope()).toBeNull()
	expect(() =>
		createToolDispatchers(
			[{ name: 'kody', fns: {} }],
			{ active: true },
			undefined,
			undefined,
			granted,
			{ boundPackageId: 'pkg-not-granted' },
		),
	).toThrow('Bound package id is not in the run grant set.')
})

test('createToolDispatchers counts host-mediated attempts, rejects sanitized-name collisions, and forwards rest args', async () => {
	const parseCall = async (result: Promise<string | undefined>) =>
		JSON.parse((await result) ?? '{}')
	const sideEffects = createEvaluationSideEffectTracker()
	let searchCalls = 0
	const dispatchers = createToolDispatchers(
		[
			{
				name: 'kody',
				fns: {
					search: async () => {
						searchCalls += 1
						throw new Error('search failed after starting')
					},
				},
			},
			{
				name: '__kodyStaticCallMeterRuntimeBridge',
				fns: { record: async () => ({ ok: true }) },
			},
		],
		{ active: true },
		undefined,
		sideEffects,
	)
	const kodyDispatcher = dispatchers.kody
	const meterDispatcher = dispatchers.__kodyStaticCallMeterRuntimeBridge
	if (!kodyDispatcher || !meterDispatcher) {
		throw new Error('Expected kody and static call meter dispatchers')
	}
	await expect(parseCall(kodyDispatcher.call('search', '{}'))).resolves.toEqual(
		{ error: 'search failed after starting' },
	)
	expect(searchCalls).toBe(1)
	expect(sideEffects.snapshot()).toEqual({
		dispatcherAttempts: 1,
		fetchAttempts: 0,
	})
	await expect(
		parseCall(meterDispatcher.call('record', JSON.stringify([{}]))),
	).resolves.toEqual({ result: { ok: true } })
	expect(sideEffects.snapshot()).toEqual({
		dispatcherAttempts: 1,
		fetchAttempts: 0,
	})

	expect(() =>
		createToolDispatchers(
			[
				{
					name: 'kody',
					fns: {
						'remote:home:set_pin': async () => ({ ok: true }),
						remotehomeset_pin: async () => ({ ok: false }),
					},
				},
			],
			{ active: true },
		),
	).toThrow(
		'Provider "kody" has tool names "remote:home:set_pin" and "remotehomeset_pin" that both sanitize to "remotehomeset_pin".',
	)

	const state = createToolDispatchers(
		[
			{
				name: 'state',
				fns: {
					readFile: async (path: unknown) => path,
					merge: async (left: unknown, right: unknown) => [left, right],
					search: async (query: unknown) => query,
				},
			},
		],
		{ active: true },
	).state
	if (!state) throw new Error('Expected state dispatcher')
	for (const [name, args, result] of [
		['readFile', ['/tmp/foo'], '/tmp/foo'],
		['merge', ['a', 'b'], ['a', 'b']],
		['search', [{ q: 'ok' }], { q: 'ok' }],
	] as const) {
		await expect(
			parseCall(state.call(name, JSON.stringify(args))),
		).resolves.toEqual({ result })
	}

	const moduleSource = await createExecutorModuleSource({
		code: 'async () => "ok"',
		providers: [{ name: 'codemode', fns: { search: async () => ({}) } }],
		shadowGlobalThis: false,
		timeoutMs: 1_000,
	})
	expect(moduleSource).toContain('async (...args) => {')
	expect(moduleSource).toContain('JSON.stringify(args)')
})

test('executor maps secret errors, formats guidance, and truncates on UTF-8 boundaries', () => {
	const hostBatchError = new Error(
		createHostSecretAccessDeniedBatchMessage([
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
				approvalUrl:
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com',
			},
		]),
	)
	expect(getExecutionErrorDetails(hostBatchError)).toMatchObject({
		kind: 'host_approval_required_batch',
		bulkApprovalUrl: null,
		missingApprovals: [
			{ secretName: 'cloudflareToken', host: 'api.cloudflare.com' },
			{ secretName: 'slackToken', host: 'slack.com' },
		],
		suggestedAction: { type: 'approve_secret_host' },
	})

	const packageApproval = (secretName: string) => ({
		secretName,
		packageId: 'pkg-1',
		kodyId: 'release',
		packageName: 'release',
		approvalUrl: `https://example.com/account/secrets/user/${secretName}?package_id=pkg-1`,
	})
	const bulkApprovalUrl =
		'https://example.com/account/secrets/approve?package_id=pkg-1&names=discordBotToken,xAccessToken'
	expect(
		getExecutionErrorDetails(
			new Error(
				createPackageSecretAccessDeniedBatchMessage(
					[packageApproval('discordBotToken'), packageApproval('xAccessToken')],
					{ bulkApprovalUrl },
				),
			),
		),
	).toMatchObject({
		kind: 'secret_package_access_required_batch',
		bulkApprovalUrl,
		missingApprovals: [
			{ secretName: 'discordBotToken', packageId: 'pkg-1' },
			{ secretName: 'xAccessToken', packageId: 'pkg-1' },
		],
	})

	expect(
		getExecutionErrorDetails(
			new Error(createMissingSecretMessage('missingToken')),
		),
	).toMatchObject({
		kind: 'secret_required',
		secretNames: ['missingToken'],
		suggestedAction: { type: 'connect_secret', reason: 'collect_secret' },
	})
	expect(
		getExecutionErrorDetails(
			new Error(createMissingSecretMessage('missingToken')),
		)?.nextStep,
	).toContain(
		'/connect/credential?kind=secret&kindMode=required&name=missingToken',
	)
	expect(
		getExecutionErrorDetails(
			new Error(createMissingSecretMessage('missingToken')),
			{ orgSlug: 'acme' },
		)?.nextStep,
	).toContain(
		'/@acme/-/credentials/new?kind=secret&kindMode=required&name=missingToken',
	)

	const reconnectHref =
		'/connect/oauth?provider=google&loginHint=kent%40gmail.com'
	const integrationRefreshError = new Error(
		`Token refresh was rejected for integration "google" with HTTP 400 (invalid_grant: Token has been expired or revoked.). Reconnect at ${reconnectHref}. (integrationTokenRefresh caller state)`,
	)
	expect(getExecutionErrorDetails(integrationRefreshError)).toMatchObject({
		kind: 'integration_auth_failed',
		integrationName: 'google',
		reconnectHref,
		suggestedAction: { type: 'reconnect_integration' },
	})
	expect(getExecutionErrorDetails(integrationRefreshError)?.nextStep).toContain(
		reconnectHref,
	)
	const spoofedReconnectError = new Error(
		`Token refresh was rejected for integration "google" with HTTP 400 (invalid_grant: Reconnect at https://attacker.example/phish). Reconnect at ${reconnectHref}. (integrationTokenRefresh caller state)`,
	)
	expect(getExecutionErrorDetails(spoofedReconnectError)).toMatchObject({
		kind: 'integration_auth_failed',
		integrationName: 'google',
		reconnectHref,
	})
	expect(
		getExecutionErrorDetails(spoofedReconnectError)?.nextStep,
	).not.toContain('attacker.example')

	const editorUrl =
		'https://example.com/account/secrets/package/pkg-1/discordBotToken'
	const scopeUnavailable = (packageName: string | null) =>
		new Error(
			createSecretScopeUnavailableMessage([
				{
					secretName: 'discordBotToken',
					scope: 'package',
					packageId: 'pkg-1',
					packageName,
					sessionId: null,
					editorUrl,
				},
			]),
		)
	expect(
		getExecutionErrorDetails(scopeUnavailable('discord-gateway')),
	).toMatchObject({
		kind: 'secret_scope_unavailable',
		secretNames: ['discordBotToken'],
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
		editorUrl,
		missingPackageContext: false,
		suggestedAction: { type: 'edit_secret_policy', policyField: 'scope' },
	})
	expect(getExecutionErrorDetails(scopeUnavailable(null))).toMatchObject({
		kind: 'secret_scope_unavailable',
		packageName: null,
		packageId: 'pkg-1',
		missingPackageContext: false,
	})
	const missingPackageContextError = new Error(
		createSecretScopeUnavailableMessage([
			{
				secretName: 'discordBotToken',
				scope: 'package',
				packageId: 'pkg-1',
				packageName: 'discord-gateway',
				sessionId: null,
				editorUrl: null,
				missingPackageContext: {
					kind: 'missing_package_context',
					runtimeLabel: 'job "nightly"',
					contextSavedAt: null,
				},
			},
		]),
	)
	expect(getExecutionErrorDetails(missingPackageContextError)).toMatchObject({
		kind: 'secret_scope_unavailable',
		missingPackageContext: true,
		suggestedAction: { type: 'republish_package' },
		editorUrl: null,
	})
	expect(
		getExecutionErrorDetails(missingPackageContextError)?.nextStep,
	).toContain('Do not widen the secret scope')

	// Plan-limit errors classify from the typed instance and from the bare
	// serialized message.
	const entitlementError = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'pro',
		limit: 3,
		current: 3,
		upgradeHint: 'Remove an old package or upgrade your plan.',
	})
	const entitlementDetails = {
		code: 'entitlement_limit_exceeded',
		resource: 'saved_packages',
		plan: 'pro',
		limit: 3,
		current: 3,
		upgradeHint: 'Remove an old package or upgrade your plan.',
	}
	expect(getExecutionErrorDetails(entitlementError)).toMatchObject({
		kind: 'entitlement_limit_exceeded',
		details: entitlementDetails,
		suggestedAction: { type: 'review_plan_limit', resource: 'saved_packages' },
	})
	expect(
		getExecutionErrorDetails(new Error(entitlementError.message)),
	).toMatchObject({
		kind: 'entitlement_limit_exceeded',
		details: entitlementDetails,
	})

	const computeOverageError = new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 60,
		creditsStatus: 'add_credits',
	})
	const computeOverageAction = {
		type: 'review_plan_limit',
		resource: 'unique_worker_days',
	}
	expect(getExecutionErrorDetails(computeOverageError)).toMatchObject({
		kind: 'compute_overage_include_reached',
		nextStep: expect.stringMatching(/Keep package code stable/),
		details: {
			code: 'compute_overage_include_reached',
			resource: 'unique_worker_days',
			plan: 'free',
			limit: 50,
			current: 60,
			creditsStatus: 'add_credits',
		},
		suggestedAction: computeOverageAction,
	})
	expect(computeOverageError.message).toMatch(/Worker compute/)
	expect(
		getExecutionErrorDetails(new Error(computeOverageError.message)),
	).toMatchObject({
		kind: 'compute_overage_include_reached',
		suggestedAction: computeOverageAction,
	})

	const intervalError = new JobIntervalFloorError({
		plan: 'free',
		minIntervalMs: 15 * 60 * 1000,
	})
	for (const error of [intervalError, new Error(intervalError.message)]) {
		expect(getExecutionErrorDetails(error)).toMatchObject({
			kind: 'job_interval_floor',
			nextStep: intervalError.details.upgradeHint,
			suggestedAction: {
				type: 'review_plan_limit',
				resource: 'scheduled_jobs',
			},
		})
	}

	// A bare ReferenceError for a kody:runtime export must point at the
	// missing import; unknown identifiers stay unhinted (ordinary user bugs).
	expect(
		getExecutionErrorDetails(new Error('kody is not defined')),
	).toMatchObject({
		kind: 'runtime_import_missing',
		exportName: 'kody',
		suggestedAction: { type: 'fix_code' },
	})
	expect(
		getExecutionErrorDetails(
			new Error('ReferenceError: secretHeaders is not defined'),
		),
	).toMatchObject({
		kind: 'runtime_import_missing',
		exportName: 'secretHeaders',
	})

	// A guard-less access to an imported-but-unbound optional kody:runtime
	// helper names the helper instead of leaving the bare TypeError. Wrapped
	// transports prefix the message; parsing stays prefix-tolerant.
	const unboundStorageMessage = createUnboundRuntimeHelperMessage({
		originalMessage: "Cannot read properties of undefined (reading 'sql')",
		helperName: 'storage',
		reference: 'storage.sql',
	})
	expect(
		getExecutionErrorDetails(new Error(unboundStorageMessage)),
	).toMatchObject({
		kind: 'runtime_helper_unbound',
		helperName: 'storage',
		suggestedAction: { type: 'fix_code' },
		nextStep: expect.any(String),
	})
	const unboundCases: Array<[string, string]> = [
		[`[execution_failed] ${unboundStorageMessage}`, 'storage'],
		// Helpers without a dedicated remedy get the generic guard guidance.
		[
			createUnboundRuntimeHelperMessage({
				originalMessage:
					"Cannot read properties of undefined (reading 'basic')",
				helperName: 'secretHeaders',
				reference: 'secretHeaders.basic',
			}),
			'secretHeaders',
		],
		[
			'kody:runtime export "packageSecrets" is not available in this execution context.',
			'packageSecrets',
		],
	]
	for (const [message, helperName] of unboundCases) {
		expect(getExecutionErrorDetails(new Error(message))).toMatchObject({
			kind: 'runtime_helper_unbound',
			helperName,
			suggestedAction: { type: 'fix_code' },
		})
	}

	// A disposed RPC stub in the sandbox means per-run state leaked into a
	// cached dynamic worker; the hint explains how to escape the poisoned
	// worker instead of suggesting a futile identical retry.
	expect(
		getExecutionErrorDetails(new Error('RPC stub used after being disposed.')),
	).toMatchObject({
		kind: 'sandbox_runtime_stale',
		suggestedAction: { type: 'report_bug' },
	})
	for (const message of [
		'Too many concurrent dynamic workers',
		'[invocation_failed] Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations. Wait for one to finish before starting another.',
	]) {
		expect(getExecutionErrorDetails(new Error(message))).toMatchObject({
			kind: 'dynamic_worker_capacity_exceeded',
			limit: 4,
			suggestedAction: { type: 'retry' },
		})
	}

	const storageEstimateError = createStorageEstimateReadError({
		storageId: 'package:unreadable',
		attempts: 3,
		cause: new Error('RPC disconnected'),
	})
	expect(
		getExecutionErrorDetails(
			new Error('Nested execute failed.', {
				cause: new Error(`[execution_failed] ${storageEstimateError.message}`),
			}),
		),
	).toMatchObject({
		kind: 'storage_estimate_unavailable',
		storageId: 'package:unreadable',
		attempts: 3,
		suggestedAction: { type: 'retry' },
	})

	// A sandbox timeout is terminal for the identical call: the hint steers
	// toward durable workflows and reports the budget baked into the message.
	// Legacy budget-less messages (explanation-carrying and bare) still
	// classify without a parsed budget; nested `[execution_failed]` causes
	// keep the budget.
	expect(
		getExecutionErrorDetails(
			new Error(createExecutorSandboxTimeoutMessage(90_000)),
		),
	).toMatchObject({
		kind: 'execution_timed_out',
		timedOutAfterMs: 90_000,
		suggestedAction: { type: 'fix_code' },
	})
	const timeoutCases: Array<[string | Error, number | null]> = [
		[executorSandboxTimeoutMessage, null],
		['Execution timed out', null],
		[
			new Error('Nested execute failed.', {
				cause: new Error(
					`[execution_failed] ${createExecutorSandboxTimeoutMessage(90_000)}`,
				),
			}),
			90_000,
		],
	]
	for (const [error, timedOutAfterMs] of timeoutCases) {
		expect(getExecutionErrorDetails(error)).toMatchObject({
			kind: 'execution_timed_out',
			timedOutAfterMs,
		})
	}

	const unhinted = [
		'myHelper is not defined',
		// Without the rewrite marker the undefined value may be any user bug.
		"Cannot read properties of undefined (reading 'sql')",
		'Too many concurrent dynamic worker requests',
		// Messages that merely mention timing out mid-sentence.
		'Upstream reported: Execution timed out unexpectedly',
	]
	expect(
		unhinted.filter(
			(message) => getExecutionErrorDetails(new Error(message)) !== null,
		),
	).toEqual([])

	for (const error of [
		hostBatchError,
		new Error(createMissingSecretMessage('missingToken')),
		new Error('kody is not defined'),
		new Error(unboundStorageMessage),
	]) {
		const output = formatExecutionOutput({
			result: undefined,
			error: error.message,
		})
		const plainOutput = `Error: ${error.message}`
		expect(output).toContain(plainOutput)
		expect(output.length).toBeGreaterThan(plainOutput.length)
	}

	expect(limitExecutionResultValue('éabc', 1)).toMatchObject({
		value: '',
		returnedBytes: 5,
		truncated: true,
	})
	const threeByteLimit = limitExecutionResultValue('éabc', 3)
	expect(threeByteLimit).toMatchObject({
		value: 'éa',
		returnedBytes: 5,
		truncated: true,
	})
	expect(
		new TextEncoder().encode(String(threeByteLimit.value)).byteLength,
	).toBe(3)
})

type RecordFetchAttempt = (
	hostSideEffects: {
		call: (name: string, argsJson: string) => Promise<string>
	} | null,
	failures: { count: number; message: string | null },
) => Promise<void>

function loadSandboxRecordFetchAttempt() {
	return new Function(
		'__kodyJsonParseCaptured',
		'__kodyErrorCaptured',
		'__kodyStringCaptured',
		`${createSandboxRecordFetchAttemptSource()}; return __kodyRecordFetchAttempt;`,
	)(JSON.parse, Error, String) as RecordFetchAttempt
}

test('sandbox fetch recording never throws when the recorder stub is disposed', async () => {
	const recordFetchAttempt = loadSandboxRecordFetchAttempt()
	const failures = { count: 0, message: null as string | null }
	const calls: Array<string> = []
	let disposed = false
	const recorder = {
		async call(name: string) {
			if (disposed) throw new Error('RPC stub used after being disposed.')
			calls.push(name)
			return JSON.stringify({ result: null })
		},
	}

	await recordFetchAttempt(recorder, failures)
	expect(calls).toEqual(['recordFetch'])
	expect(failures).toEqual({ count: 0, message: null })

	disposed = true
	await expect(recordFetchAttempt(recorder, failures)).resolves.toBeUndefined()
	await expect(recordFetchAttempt(recorder, failures)).resolves.toBeUndefined()
	expect(failures).toEqual({
		count: 2,
		message: 'RPC stub used after being disposed.',
	})

	const errorEnvelope = {
		async call() {
			return JSON.stringify({ error: 'Execution has already completed.' })
		},
	}
	const envelopeFailures = { count: 0, message: null as string | null }
	await expect(
		recordFetchAttempt(errorEnvelope, envelopeFailures),
	).resolves.toBeUndefined()
	expect(envelopeFailures).toEqual({
		count: 1,
		message: 'Execution has already completed.',
	})

	await expect(recordFetchAttempt(null, failures)).resolves.toBeUndefined()
	expect(failures.count).toBe(2)
})
