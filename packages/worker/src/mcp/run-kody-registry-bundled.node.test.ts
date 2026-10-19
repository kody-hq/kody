import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import * as registryModule from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as moduleGraph from '#worker/package-runtime/module-graph.ts'
import { runBundledModuleWithRegistry } from './run-kody-registry.ts'
import * as mcpExecutor from '#mcp/executor.ts'
import { createFakeRunLogNamespace } from '#worker/test-support/run-kody-registry.ts'
import * as settingsService from '#worker/mcp-client/settings-service.ts'
import * as hubClient from '#worker/mcp-client/hub-client.ts'
import * as usageModule from '#worker/usage/record-usage.ts'
import * as runRecords from '#worker/run-records/service.ts'
import {
	callerDisconnectedSandboxLog,
	packageInvocationClientDisconnectedErrorName,
} from '#worker/caller-disconnect.ts'
import { createStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import { d1NetworkConnectionLostMessage } from '#worker/d1-retry.ts'

vi.mock('#worker/package-runtime/module-graph.ts', async () => {
	const actual = await vi.importActual<typeof moduleGraph>(
		'#worker/package-runtime/module-graph.ts',
	)
	return {
		...actual,
		buildKodyModuleBundle: vi.fn(async () => ({
			mainModule: 'entry.js',
			modules: {
				'entry.js':
					'export default async function main(input = {}) { return input }',
			},
		})),
	}
})

type ProviderFns = Record<string, (args: unknown) => Promise<unknown>>

function requireFn<Fn>(fns: Record<string, Fn>, name: string): Fn {
	const fn = fns[name]
	if (!fn) throw new Error(`Expected kody function "${name}"`)
	return fn
}
type Providers = Array<{ fns: ProviderFns }>
type RunOptions = NonNullable<
	Parameters<typeof runBundledModuleWithRegistry>[4]
>

const env = {} as Env
const emptyRegistry = {
	capabilityDomains: [],
	capabilityDomainDescriptionsByName: {} as Record<string, string>,
	capabilityHandlers: {},
	capabilityList: [],
	capabilityMap: {},
	capabilitySpecs: {},
	capabilityToolDescriptors: {},
} as Awaited<ReturnType<typeof registryModule.getCapabilityRegistryForContext>>
const okBundle = {
	mainModule: 'entry.js',
	modules: { 'entry.js': 'export default async () => "ok"' },
}
const callerFor = (userId = 'user-123') =>
	createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored(userId),
			email: `${userId}@example.com`,
			displayName: userId,
		},
	})

const runOk = (options: RunOptions = {}, callerContext = callerFor()) =>
	runBundledModuleWithRegistry(env, callerContext, okBundle, undefined, {
		skipCapabilityRegistry: true,
		...options,
	})

function mockExecutor(
	initial: (providers: Providers) => unknown = () => ({
		result: 'ok',
		logs: [],
	}),
) {
	let respond = initial
	const calls: Array<{
		source: string
		providers: Providers
		input: Parameters<typeof mcpExecutor.createExecuteExecutor>[0]
	}> = []
	const spy = vi.spyOn(mcpExecutor, 'createExecuteExecutor').mockImplementation(
		(input) =>
			({
				async execute(source: unknown, providers: Providers) {
					input.onWorkerId?.('kody-testworkerid00000000000000000000000000')
					calls.push({ source: String(source), providers, input })
					return await respond(providers)
				},
			}) as never,
	)
	return {
		spy,
		calls,
		fns: () => calls.at(-1)!.providers[0]!.fns,
		respondWith(next: typeof initial) {
			respond = next
		},
	}
}

function createWorkflowEnv() {
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const workflowEnv = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind() {
						return {
							async first() {
								if (query.includes('COUNT(*) AS count')) return { count: 0 }
								return null
							},
							async all() {
								throw new Error(`Unsupported all query: ${query}`)
							},
							async run() {
								throw new Error(`Unsupported run query: ${query}`)
							},
						}
					},
				}
			},
		} as unknown as D1Database,
		RUN_LOG: createFakeRunLogNamespace().namespace,
		DYNAMIC_CALLABLE_WORKFLOWS: {
			get: async () => {
				throw new Error('not found')
			},
			create: async (options?: WorkflowInstanceCreateOptions<unknown>) => {
				if (!options) throw new Error('missing options')
				created.push(options)
				return {
					id: options.id ?? 'generated',
					status: async () => ({ status: 'queued' }),
				} as WorkflowInstance
			},
			createBatch: async () => {
				throw new Error('createBatch is not supported in this test')
			},
			deleteBatch: async () => {
				throw new Error('deleteBatch is not supported in this test')
			},
		} as Workflow<unknown>,
	} as Env
	return { workflowEnv, created }
}

test('runBundledModuleWithRegistry passes params and injects runtime helpers', async () => {
	silenceIncidentalRuntimeWarnings()
	vi.spyOn(registryModule, 'getCapabilityRegistryForContext').mockResolvedValue(
		emptyRegistry,
	)
	const executor = mockExecutor(() => ({
		result: { room: 'office' },
		logs: [],
	}))

	const paramsResult = await runBundledModuleWithRegistry(
		env,
		callerFor(),
		{
			mainModule: 'entry.js',
			modules: {
				'entry.js':
					'export default async function main(input = {}) { return input }',
			},
		},
		{ room: 'office' },
		{ skipCapabilityRegistry: true },
	)
	expect(paramsResult.result).toEqual({ room: 'office' })

	executor.respondWith(() => ({ result: 'ok', logs: [] }))
	const emailResult = await runOk({
		skipCapabilityRegistry: false,
		emailTools: {
			getMessage: async (messageId) => ({ id: messageId, subject: 'Hello' }),
			getAttachment: async (attachmentId) => ({
				id: attachmentId,
				text: 'hello',
			}),
		},
	})
	expect(emailResult.result).toBe('ok')
	await expect(
		requireFn(executor.fns(), 'emailMessageGet')({ message_id: 'message-1' }),
	).resolves.toEqual({ id: 'message-1', subject: 'Hello' })
	await expect(
		requireFn(
			executor.fns(),
			'emailAttachmentGet',
		)({ attachment_id: 'attachment-1' }),
	).resolves.toEqual({ id: 'attachment-1', text: 'hello' })

	const workflowResult = await runOk({
		skipCapabilityRegistry: false,
		workflowTools: { create: async (input) => ({ ok: true, input }) },
	})
	expect(workflowResult.result).toBe('ok')
	await expect(
		requireFn(
			executor.fns(),
			'packageWorkflowCreate',
		)({ workflowName: 'custom' }),
	).resolves.toEqual({ ok: true, input: { workflowName: 'custom' } })

	const packageEventResult = await runOk({
		skipCapabilityRegistry: false,
		packageEventTools: { dispatch: async (input) => ({ ok: true, input }) },
	})
	expect(packageEventResult.result).toBe('ok')
	// Main provider + computed-import bridge + package-events bridge +
	// static-call meter bridge (bound whenever the run has a user).
	const packageEventProviders = executor.calls.at(-1)!.providers
	expect(packageEventProviders).toHaveLength(4)
	await expect(
		requireFn(packageEventProviders[2]!.fns, 'dispatch')({ topic: 'x' }),
	).resolves.toEqual({ ok: true, input: { topic: 'x' } })

	const { workflowEnv, created } = createWorkflowEnv()
	await runBundledModuleWithRegistry(
		workflowEnv,
		callerFor(),
		okBundle,
		undefined,
		{ packageContext: null },
	)
	await expect(
		requireFn(
			executor.fns(),
			'packageWorkflowCreate',
		)({
			runAt: '2026-05-03T12:00:00.000Z',
			idempotencyKey: 'execute-smoke',
			code: 'export default async function main(p){ return { ok: true, p }; }',
			params: { greeting: 'hello' },
		}),
	).resolves.toMatchObject({
		ok: true,
		source_type: 'inline',
		status: 'queued',
	})
	expect(created[0]?.params).toEqual(
		expect.objectContaining({
			sourceType: 'inline',
			userId: ownerIdFromStored('user-123'),
			params: { greeting: 'hello' },
		}),
	)
})

test('closed-world retriever runtime skips capabilities, hub snapshots, workflows, invoke, and outbound fetch', async () => {
	silenceIncidentalRuntimeWarnings()
	const getRegistrySpy = vi
		.spyOn(registryModule, 'getCapabilityRegistryForContext')
		.mockResolvedValue({} as never)
	const listMcpServerRefsSpy = vi
		.spyOn(settingsService, 'listEnabledMcpServerRefsCached')
		.mockResolvedValue([])
	const getHubSnapshotSpy = vi
		.spyOn(hubClient, 'getCachedMcpClientHubSnapshot')
		.mockResolvedValue({ servers: [] })
	const executor = mockExecutor()

	const result = await runOk({
		skipCapabilityRegistry: false,
		closedWorldRetrieverRuntime: true,
		packageContext: {
			packageId: 'pkg-1',
			kodyId: 'notes',
			sourceId: 'source-1',
		},
		packageEventTools: {
			dispatch: async () => {
				throw new Error('dispatch should not be bound')
			},
		},
	})
	expect(result.result).toBe('ok')
	expect(getRegistrySpy).not.toHaveBeenCalled()
	expect(listMcpServerRefsSpy).not.toHaveBeenCalled()
	expect(getHubSnapshotSpy).not.toHaveBeenCalled()
	expect(executor.calls[0]?.input.allowOutboundFetch).toBe(false)
	const fns = executor.fns()
	expect(fns.packageWorkflowCreate).toBeUndefined()
	expect(fns.emailSend).toBeUndefined()
	await expect(fns.packageStorageSet?.({})).rejects.toThrow(
		'packageStorage() is read-only during retriever runs',
	)
})

test('runBundledModuleWithRegistry uses a prebuilt capability registry and gates execute metering', async () => {
	silenceIncidentalRuntimeWarnings()
	const getRegistrySpy = vi
		.spyOn(registryModule, 'getCapabilityRegistryForContext')
		.mockResolvedValue(emptyRegistry)
	const executor = mockExecutor()

	await runOk({
		skipCapabilityRegistry: false,
		capabilityRegistry: emptyRegistry,
	})
	expect(getRegistrySpy).not.toHaveBeenCalled()
	await runOk({ skipCapabilityRegistry: false })
	expect(getRegistrySpy).toHaveBeenCalledTimes(1)

	// skipExecuteUsage suppresses execute metering on nested library loads.
	executor.spy.mockClear()
	await runOk({ packageContext: null, skipExecuteUsage: true })
	await runOk({ packageContext: null })
	expect(
		executor.spy.mock.calls.map(([input]) => input.recordExecuteUsage),
	).toEqual([false, true])
})

test('runBundledModuleWithRegistry records package_export usage for bundled runs with package context', async () => {
	silenceIncidentalRuntimeWarnings()
	const callerContext = callerFor('user-metered')
	const packageContext = {
		packageId: 'pkg-metered',
		kodyId: 'metered-package',
		sourceId: 'source-metered',
	}
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const executor = mockExecutor()
	const runPackage = () => runOk({ packageContext }, callerContext)
	const expectOnePackageExport = (outcome: 'success' | 'error') => {
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: ownerIdFromStored('user-metered'),
				eventType: 'package_export',
				entityId: 'pkg-metered',
				outcome,
				durationMs: expect.any(Number),
			}),
		)
		expect(
			recordUsageSpy.mock.calls[0]?.[1]?.durationMs,
		).toBeGreaterThanOrEqual(0)
		recordUsageSpy.mockClear()
	}

	expect((await runPackage()).result).toBe('ok')
	expect(executor.spy).toHaveBeenCalledWith(
		expect.objectContaining({ recordExecuteUsage: false }),
	)
	expectOnePackageExport('success')

	executor.respondWith(() => ({
		result: undefined,
		error: 'sandbox failed',
		logs: [],
	}))
	expect((await runPackage()).error).toBe('sandbox failed')
	expectOnePackageExport('error')

	// No package context or no signed-in user: nothing recorded.
	executor.respondWith(() => ({ result: 'ok', logs: [] }))
	await runOk({}, callerContext)
	await runOk(
		{ packageContext },
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: null,
		}),
	)
	expect(recordUsageSpy).not.toHaveBeenCalled()

	// Failures before the sandbox ever runs (executor construction, module
	// hydration, provider assembly) still count as failed package runs.
	executor.spy.mockImplementation(() => {
		throw new Error('executor construction failed')
	})
	await expect(runPackage()).rejects.toThrow('executor construction failed')
	expectOnePackageExport('error')
})

test('runBundledModuleWithRegistry injects OAuth helper prelude only when execute helper capabilities are present', async () => {
	silenceIncidentalRuntimeWarnings()
	const executor = mockExecutor()

	await expect(runOk()).resolves.toMatchObject({ result: 'ok' })
	await expect(
		runOk({
			additionalTools: {
				integrationGet: async () => ({}),
				integrationTokenRefresh: async () => ({}),
				valueGet: async () => ({}),
			},
		}),
	).resolves.toMatchObject({ result: 'ok' })

	const [withoutHelpers, withHelpers] = executor.calls.map((c) => c.source)
	expect(withoutHelpers).not.toContain('__kodyCreateAuthenticatedFetch')
	expect(withHelpers).toContain('__kodyCreateAuthenticatedFetch')
	expect(withHelpers!.length).toBeGreaterThan(withoutHelpers!.length)
})

test('runBundledModuleWithRegistry rewrites guard-less unbound runtime helper errors with a bound-context hint', async () => {
	silenceIncidentalRuntimeWarnings()
	const bareTypeError = "Cannot read properties of null (reading 'getMessage')"
	mockExecutor(() => ({ result: undefined, error: bareTypeError, logs: [] }))
	const dynamicImportEntry = `export default async function main() {
	const mod = await import('kody:@scope/notes/note-list')
	return await mod.default({})
}`

	// Mirrors a saved-package export imported statically into an ad hoc
	// execute call: the bundled module imports `email` through the rewritten
	// virtual runtime path and calls it without a falsiness guard.
	const unboundResult = await runBundledModuleWithRegistry(
		env,
		callerFor(),
		{
			mainModule: 'entry.js',
			modules: {
				'entry.js': `import { email } from './.__kody_virtual__/runtime.js'

export default async function main() {
	return await email.getMessage('m-1')
}`,
			},
		},
		undefined,
		{ skipCapabilityRegistry: true },
	)
	expect(unboundResult.error).toContain(bareTypeError)
	const details = mcpExecutor.getExecutionErrorDetails(unboundResult.error)
	expect(details).toMatchObject({
		kind: 'runtime_helper_unbound',
		helperName: 'email',
		nextStep: expect.stringContaining('email-triggered'),
	})

	// Guard-less access inside a dynamically hydrated package module
	// (literal dynamic `import("kody:@...")` target) must be matched too:
	// the original bundle has no runtime import, only the hydrated module
	// graph the sandbox actually executed does.
	vi.spyOn(moduleGraph, 'hydrateKodyRuntimeModules').mockResolvedValue({
		modules: {
			'entry.js': dynamicImportEntry,
			'.__kody_dynamic__/scope/notes/note-list.js': `import { email } from '../../.__kody_virtual__/runtime.js'
export default async () => await email.getMessage('m-1')`,
		},
		dynamicDependencyPackageIds: [],
	})
	const hydratedResult = await runBundledModuleWithRegistry(
		env,
		callerFor(),
		{ mainModule: 'entry.js', modules: { 'entry.js': dynamicImportEntry } },
		undefined,
		{ skipCapabilityRegistry: true },
	)
	expect(hydratedResult.error).toContain(
		'The optional kody:runtime export "email" is not bound in this execution context',
	)
})

test('runBundledModuleWithRegistry records execute run success, failure, and caller disconnect', async () => {
	silenceIncidentalRuntimeWarnings()
	const callerContext = callerFor('user-execute-records')
	const handle = {
		id: 'run-execute-1',
		userId: ownerIdFromStored('user-execute-records'),
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'execute' as const,
			name: null,
			storageId: 'storage-1',
			metadata: { conversationId: 'conv-1' },
		},
	}
	const runRecord = {
		surface: 'execute' as const,
		name: null,
		storageId: 'storage-1',
		metadata: { conversationId: 'conv-1' },
	}
	const beginSpy = vi
		.spyOn(runRecords, 'beginRunRecord')
		.mockReturnValue(handle)
	const persistedStatuses: Array<string> = []
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockImplementation(async (input) => {
			if (!input.handle) return false
			persistedStatuses.push(input.status)
			return true
		})
	const executor = mockExecutor(() => ({
		result: 'ok',
		logs: ['success log'],
	}))

	const success = await runOk({ runRecord }, callerContext)
	expect(success.error).toBeUndefined()
	expect(success.runId).toBe(handle.id)
	expect(beginSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-execute-records'),
			context: expect.objectContaining({
				surface: 'execute',
				storageId: 'storage-1',
			}),
		}),
	)
	expect(finishSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'success',
			logs: ['success log'],
			result: 'ok',
		}),
	)
	expect(handle.context.metadata).toEqual(
		expect.objectContaining({
			conversationId: 'conv-1',
			sandboxMs: expect.any(Number),
			workerId: 'kody-testworkerid00000000000000000000000000',
		}),
	)

	finishSpy.mockClear()
	const timeoutMessage = mcpExecutor.createExecutorSandboxTimeoutMessage(2_500)
	executor.respondWith(() => ({
		result: undefined,
		error: timeoutMessage,
		logs: ['failure log'],
	}))
	const failure = await runOk({ runRecord }, callerContext)
	expect(failure.error).toBe(timeoutMessage)
	expect(failure.runId).toBe(handle.id)
	expect(finishSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'error',
			logs: ['failure log'],
			error: expect.objectContaining({
				name: 'TimeoutError',
				message: timeoutMessage,
			}),
		}),
	)
	expect(persistedStatuses).toEqual(['success', 'error'])

	// A caller disconnect before the sandbox runs finishes as
	// client_disconnected.
	finishSpy.mockClear()
	executor.respondWith(() => ({ result: 'should-not-run', logs: [] }))
	const controller = new AbortController()
	controller.abort(new DOMException('The operation was aborted.', 'AbortError'))
	await expect(
		runOk({ signal: controller.signal, runRecord }, callerContext),
	).rejects.toMatchObject({ name: 'AbortError' })
	expect(finishSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'error',
			logs: [callerDisconnectedSandboxLog],
			error: expect.objectContaining({
				name: packageInvocationClientDisconnectedErrorName,
			}),
		}),
	)
})

test('runBundledModuleWithRegistry leaves claimed job transient failures running', async () => {
	silenceIncidentalRuntimeWarnings()
	const callerContext = callerFor('user-job-estimate')
	const handle = {
		id: 'run-job-estimate-1',
		userId: ownerIdFromStored('user-job-estimate'),
		startedAt: '2026-08-21T14:40:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'job' as const,
			name: 'sweep',
			jobId: 'package-job:estimate:sweep',
			metadata: {},
		},
	}
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockResolvedValue(true)
	let executeError: unknown
	mockExecutor(() => {
		if (executeError instanceof Error) throw executeError
		return { result: undefined, error: executeError, logs: [] }
	})
	const runClaimedJob = () =>
		runOk(
			{
				runRecord: {
					surface: 'job',
					name: 'sweep',
					jobId: 'package-job:estimate:sweep',
				},
				runRecordHandle: handle,
			},
			callerContext,
		)
	const connectionLost = `${d1NetworkConnectionLostMessage}.`

	for (const error of [
		createStorageEstimateReadError({
			storageId: 'package:estimate-target',
			attempts: 4,
			cause: new Error('Storage estimate read timed out after 2000ms.'),
		}).message,
		connectionLost,
		`D1_ERROR: ${connectionLost}`,
	]) {
		executeError = error
		expect((await runClaimedJob()).error).toBe(error)
	}
	executeError = new Error(connectionLost)
	await expect(runClaimedJob()).rejects.toThrow(connectionLost)
	expect(finishSpy).not.toHaveBeenCalled()

	executeError = 'user code failed'
	expect((await runClaimedJob()).error).toBe('user code failed')
	expect(finishSpy).toHaveBeenCalledWith(
		expect.objectContaining({ handle, status: 'error' }),
	)

	// Non-job surfaces finish transient failures as errors.
	finishSpy.mockClear()
	executeError = connectionLost
	const executeFailure = await runOk(
		{
			runRecord: { surface: 'execute', name: null, storageId: 'storage-1' },
			runRecordHandle: {
				...handle,
				context: {
					surface: 'execute',
					name: null,
					storageId: 'storage-1',
					metadata: {},
				},
			},
		},
		callerContext,
	)
	expect(executeFailure.error).toBe(connectionLost)
	expect(finishSpy).toHaveBeenCalledWith(
		expect.objectContaining({ status: 'error' }),
	)
})

test('runBundledModuleWithRegistry retries transient Durable Object isolate resets', async () => {
	silenceIncidentalRuntimeWarnings()
	const handle = {
		id: 'run-do-reset-1',
		userId: ownerIdFromStored('user-do-reset'),
		startedAt: '2026-08-18T00:00:00.000Z',
		persistence: 'on-failure' as const,
		context: { surface: 'export' as const, name: './scan', metadata: {} },
	}
	vi.spyOn(runRecords, 'beginRunRecord').mockReturnValue(handle)
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockResolvedValue(true)
	const resetMessage = 'Durable Object reset because its code was updated.'
	const resetResult = (dispatcherAttempts: number) => ({
		result: undefined,
		error: resetMessage,
		logs: [],
		hostMediatedSideEffects: { dispatcherAttempts, fetchAttempts: 0 },
	})
	const execute = vi
		.fn()
		.mockResolvedValueOnce(resetResult(0))
		.mockResolvedValueOnce({
			result: { scanned: 2 },
			logs: ['recovered'],
			hostMediatedSideEffects: { dispatcherAttempts: 0, fetchAttempts: 0 },
		})
	vi.spyOn(mcpExecutor, 'createExecuteExecutor').mockReturnValue({
		execute,
	} as never)
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const resetWarning = expect.stringContaining(
		'runBundledModuleWithRegistry transient Durable Object reset',
	)
	const runScan = () =>
		runOk(
			{ runRecord: { surface: 'export', name: './scan' } },
			callerFor('user-do-reset'),
		)

	vi.useFakeTimers()
	try {
		const recoveredPending = runScan()
		await vi.runAllTimersAsync()
		const recovered = await recoveredPending
		expect(recovered.error).toBeUndefined()
		expect(recovered.result).toEqual({ scanned: 2 })
		expect(execute).toHaveBeenCalledTimes(2)
		expect(finishSpy).toHaveBeenCalledTimes(1)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'success',
				result: { scanned: 2 },
			}),
		)
		expect(consoleWarn).toHaveBeenCalledWith(resetWarning)

		execute.mockReset()
		finishSpy.mockClear()
		execute.mockResolvedValue(resetResult(0))
		const exhaustedPending = runScan()
		await vi.runAllTimersAsync()
		expect((await exhaustedPending).error).toBe(resetMessage)
		expect(execute).toHaveBeenCalledTimes(4)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'error',
				error: expect.objectContaining({ message: resetMessage }),
			}),
		)

		// Host-mediated side effects make the reset unsafe to retry.
		execute.mockReset()
		consoleWarn.mockClear()
		execute.mockResolvedValue(resetResult(1))
		expect((await runScan()).error).toBe(resetMessage)
		expect(execute).toHaveBeenCalledTimes(1)
		expect(consoleWarn).not.toHaveBeenCalledWith(resetWarning)
	} finally {
		vi.useRealTimers()
	}
})

test('runBundledModuleWithRegistry schedules finish via waitUntil when provided', async () => {
	silenceIncidentalRuntimeWarnings()
	const handle = {
		id: 'run-wait-until-1',
		userId: ownerIdFromStored('user-wait-until'),
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'subscription' as const,
			name: 'email.message.received',
		},
	}
	vi.spyOn(runRecords, 'beginRunRecord').mockReturnValue(handle)
	let resolveFinish: (() => void) | undefined
	const finishGate = new Promise<void>((resolve) => {
		resolveFinish = resolve
	})
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockImplementation(async (input) => {
			if (input.waitUntil) {
				input.waitUntil(finishGate)
				return true
			}
			await finishGate
			return true
		})
	mockExecutor()
	const waitUntilTasks: Array<Promise<unknown>> = []

	const result = await runOk(
		{
			runRecord: { surface: 'subscription', name: 'email.message.received' },
			waitUntil: (promise) => {
				waitUntilTasks.push(promise)
			},
		},
		callerFor('user-wait-until'),
	)
	expect(result.error).toBeUndefined()
	expect(finishSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'success',
			waitUntil: expect.any(Function),
		}),
	)
	// finishRunRecord schedules one waitUntil task; static-call finalize
	// schedules another when the meter is armed for the caller.
	expect(waitUntilTasks.length).toBeGreaterThanOrEqual(1)
	resolveFinish?.()
	await Promise.all(waitUntilTasks)
})
