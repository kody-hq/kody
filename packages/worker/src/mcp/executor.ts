import {
	sanitizeToolName,
	ToolDispatcher,
	type ExecuteResult,
	type ResolvedProvider,
} from '@cloudflare/codemode'
import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import {
	isWorkersHungRequestCanceledError,
	workersHungExecutionMessage,
} from '@kody-internal/shared/workers-hung-request.ts'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { exports as workerExports } from 'cloudflare:workers'
import { loadNormalizeCode } from '#worker/codemode-normalize-load.ts'
import {
	dynamicWorkerUsageTailLoaderIdSuffix,
	type DynamicWorkerUsageTailProps,
} from '#worker/usage/dynamic-worker-cpu.ts'
import { defaultExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import { type FetchGatewayProps } from '#mcp/fetch-gateway.ts'
import { pathSegmentEncodingWarningHeaderName } from '#mcp/secrets/path-segment-encoding-warning.ts'
import {
	readBaseUrlHostname,
	type RawFetchHostSink,
} from '#mcp/raw-fetch-host-nudge.ts'
import { extractMcpPassthrough } from '#mcp/downstream-mcp-result.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
	usageConnectionFieldsFromRequest,
	type UsageEnv,
	type UsageEvent,
} from '#worker/usage/record-usage.ts'
import { recordUniqueDynamicWorkerDay } from '#worker/usage/dynamic-worker-day.ts'
import {
	countDynamicWorkerModuleGraphChars,
	countEvaluateInvocationParamsChars,
	recordDynamicWorkerInvoke,
} from '#worker/usage/dynamic-worker-invoke.ts'
import { type DynamicWorkerDaySurface } from '#worker/usage/dynamic-worker-day-surface.ts'
import { type ExecuteThinGlueClass } from '#worker/usage/execute-thin-glue.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	isSecretAuthRequiredMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
	parsePackageAccessRequiredBatchMessage,
	parsePackageAccessRequiredMessage,
	parseSecretScopeUnavailableMessage,
} from '#mcp/secrets/errors.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import {
	isComputeOverageLimitError,
	isEntitlementLimitError,
	isJobIntervalFloorError,
	parseComputeOverageLimitMessage,
	parseEntitlementLimitMessage,
	parseJobIntervalFloorMessage,
	type ComputeOverageLimitErrorDetails,
	type EntitlementLimitErrorDetails,
} from '#worker/entitlements/errors.ts'
import { buildIntegrationReconnectHref } from '#universal/connection-trouble.ts'
import { buildCredentialCreateHref } from '#universal/credential-contracts.ts'
import { isIntegrationTokenRefreshCallerMessage } from '#worker/integrations/token-refresh.ts'
import {
	type KodyMcpServerMetadata,
	type KodyResolvedProvider,
} from '#mcp/kody-remote-types.ts'
import {
	createKodyProviderProxySource,
	projectKodyRemoteProxyMetadata,
	type KodyRemoteProxyEvaluateMetadata,
} from '#mcp/kody-provider-proxy-source.ts'
import {
	grantedSecretAuthorityPackageIdSet,
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
	secretAuthorityArgName,
	secretAuthorityHeaderName,
	takeSecretAuthorityFromCapabilityArgs,
} from '#mcp/secrets/secret-authority.ts'
import {
	buildUnboundRuntimeHelperNextStep,
	parseUnboundRuntimeHelperMessage,
} from '#worker/package-runtime/unbound-runtime-helpers.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import {
	getDynamicWorkerEvaluationContext,
	isDynamicWorkerCapacityErrorMessage,
	maxConcurrentDynamicWorkerEvaluationsPerRequest,
	runWithCapturedDynamicWorkerEvaluationContext,
	withDynamicWorkerEvaluationPermit,
} from '#worker/dynamic-worker-evaluation-budget.ts'
import {
	executorSandboxTimeoutMessage,
	executorSandboxTimeoutMessageExplanation,
	executorSandboxTimeoutMessagePrefix,
	isExecutorSandboxTimeoutMessage,
} from '#worker/sentry-options.ts'
import {
	callerDisconnectedSandboxLog,
	callerDisconnectedSandboxMessage,
	createCallerDisconnectedExecutionError,
	isCallerDisconnectedSandboxMessage,
} from '#worker/caller-disconnect.ts'
import { parseStorageEstimateReadErrorMessage } from '#worker/storage-estimate-error.ts'
import {
	kodyCallDispatcherName,
	kodyProviderEvaluateBindingName,
} from '#worker/kody-evaluate-bindings.ts'
import { isTransientDurableObjectResetError } from '#worker/durable-object-reset-retry.ts'
import { createStableDynamicWorkerId } from '#mcp/dynamic-worker-id.ts'
import {
	createEvaluationSideEffectTracker,
	createHostSideEffectProvider,
	hostSideEffectProviderName,
	isPlatformOnlyHostSideEffectProvider,
	type EvaluationHostSideEffects,
	type EvaluationSideEffectTracker,
} from '#mcp/evaluation-side-effects.ts'

type WorkerLoopbackExports = Exclude<typeof workerExports, undefined>

export { runWithDynamicWorkerEvaluationBudget } from '#worker/dynamic-worker-evaluation-budget.ts'

export const defaultExecutionResponseLimitBytes = 102_400
const maxSupportedExecutorTimeoutMs = 2_147_483_647
const dynamicWorkerMainModule = 'executor.js'
const hostEvaluationDrainGraceMs = 100
/**
 * Cloudflare hang-detects requests that only wait on timers once a dynamic
 * worker's event loop is empty (~15–25s observed). `scheduler.wait` is real
 * I/O on Workers and keeps the host deadline alive until evaluate settles or
 * the sandbox budget fires. Interval stays well under that hung window.
 */
const hostEvaluationKeepAliveIntervalMs = 5_000
const reservedProviderNames = new Set([
	'__dispatchers',
	'__invocation',
	'__logs',
	hostSideEffectProviderName,
])
const validProviderNamePattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
const javascriptReservedWords = new Set([
	'arguments',
	'async',
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'implements',
	'import',
	'in',
	'interface',
	'instanceof',
	'let',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'static',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield',
	'eval',
])

type DynamicWorkerExecutorInput = {
	loader: Env['LOADER']
	timeout: number
	signal?: AbortSignal
	globalOutbound: Fetcher | null
	/** Mints this run's outbound fetch gateway; passed on each evaluate call. */
	createRunFetcher?: () => Fetcher
	/**
	 * Mints the trusted per-package fetch binding for one package in the run's
	 * grant set (GHSA-5fv3): a KodyFetchGateway whose host-set
	 * `boundPackageId` prop is the package's secret identity. Omitted when
	 * outbound fetch is disabled.
	 */
	createPackageFetcher?: (packageId: string) => Fetcher
	/**
	 * Builds the tail worker that records Cloudflare-measured CPU for this
	 * isolate (`dynamic_worker_cpu`). Omitted when the loopback export is not
	 * available; the run is unaffected either way.
	 */
	createUsageTail?: (props: DynamicWorkerUsageTailProps) => Fetcher
	modules?: WorkerLoaderModules
	gatewayProps: FetchGatewayProps
	usageEnv: UsageEnv & UserMeterEnv
	rawFetchHostSink?: RawFetchHostSink
	/**
	 * When false, skip the `execute` usage event. Job, package-export, and
	 * other nested surfaces record their own metrics; only MCP execute-tool
	 * runs (and ad-hoc executor callers) should emit `execute`.
	 */
	recordExecuteUsage?: boolean
	/**
	 * Surface that minted this Dynamic Worker. Defaults to `execute` for
	 * ad-hoc executor callers. Nested surfaces pass the mapped UWD tag.
	 */
	surface?: DynamicWorkerDaySurface
	/**
	 * Saved package id when this worker belongs to a known package run.
	 * Falls back to `invocation.packageContext.packageId` at claim time.
	 * Omit for ad hoc execute; never guess.
	 */
	packageId?: string | null
	/**
	 * Host-side thin/glue class for ad-hoc execute usage events. Omit on
	 * nested surfaces.
	 */
	executeShape?: ExecuteThinGlueClass | null
	/**
	 * Called once the stable LOADER worker id is minted (same id unique_worker_days
	 * meters). Use to stamp run metadata before evaluate finishes.
	 */
	onWorkerId?: (workerId: string) => void
	/**
	 * Capped unique-worker-day claim. Awaited before the worker loads, so a
	 * throw (plan limit) stops the run without a load. Must record the
	 * `dynamic_worker_day` usage event itself. Omit to use the uncapped
	 * attribution claim.
	 */
	claimWorkerDay?: ClaimWorkerDay
	/**
	 * When set, unique-worker-day metering and the first-execute activation
	 * stamp run on `waitUntil` instead of the sandbox critical path. Without
	 * an execution context the writes stay awaited so they are not dropped.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
}

export type ClaimWorkerDayAttribution = Pick<
	UsageEvent,
	'packageId' | 'connectionKey'
>

export type ClaimWorkerDay = (
	workerId: string,
	attribution: ClaimWorkerDayAttribution,
) => Promise<{ created: boolean }>

export type DynamicWorkerEvaluatePackageContext = {
	packageId: string
	kodyId: string
	sourceId?: string | null
} | null

/**
 * Per-evaluate payload. Must stay out of WorkerCode so LOADER ids reuse
 * across different `params` / `packageContext` / live MCP status.
 */
export type DynamicWorkerEvaluateInvocation = {
	params?: unknown
	packageContext?: DynamicWorkerEvaluatePackageContext
	mcpServers?: Array<KodyRemoteProxyEvaluateMetadata>
}

type DynamicWorkerEntrypoint = {
	evaluate(
		dispatchers: Record<string, ToolDispatcher>,
		invocation?: DynamicWorkerEvaluateInvocation,
		packageBindings?: PackageBindingStubs | null,
		runFetcher?: Fetcher | null,
	): Promise<{
		result: unknown
		error?: string
		logs?: Array<string>
		rawFetchHosts?: Array<string>
	}>
}

/**
 * Trusted per-package bindings handed to one `evaluate()` call (GHSA-5fv3).
 * Keyed by saved-package id; each entry's identity lives in host-set props
 * on its stubs, never in a value the sandbox can read or forge. Only the
 * host-generated wrapper sees this object; it installs it in the runtime
 * module's private binding scope for that package's module-bound helpers.
 */
export type PackageBindingStubs = Record<
	string,
	{ fetcher?: Fetcher | null; kody?: ToolDispatcher | null }
>

function cloneEvaluateJsonValue<T>(value: T): T {
	if (value === undefined) return value
	return JSON.parse(JSON.stringify(value)) as T
}

function resolveEvaluateInvocation(
	providers: Array<ResolvedProvider>,
	invocation?: DynamicWorkerEvaluateInvocation,
): DynamicWorkerEvaluateInvocation {
	const kodyProvider = providers.find(
		(provider) => provider.name === 'kody',
	) as KodyResolvedProvider | undefined
	const packageContext =
		cloneEvaluateJsonValue(invocation?.packageContext ?? null) ?? null
	return {
		params: cloneEvaluateJsonValue(invocation?.params),
		packageContext:
			packageContext == null ? null : Object.freeze({ ...packageContext }),
		mcpServers: projectKodyRemoteProxyMetadata(
			invocation?.mcpServers ?? kodyProvider?.kodyMcpServers ?? [],
		),
	}
}

export type ExecuteResultWithHostSideEffects = ExecuteResult & {
	hostMediatedSideEffects: EvaluationHostSideEffects
}

function attachHostSideEffects(
	result: ExecuteResult,
	sideEffects: EvaluationSideEffectTracker,
): ExecuteResultWithHostSideEffects {
	return {
		...result,
		hostMediatedSideEffects: sideEffects.snapshot(),
	}
}

class HostEvaluationTimeoutError<T> extends Error {
	name = 'TimeoutError'
	evaluationResult?: T
}

/**
 * The executor is the only component that knows the enforced budget at the
 * moment a timeout fires, so it bakes the budget into the message
 * (`Execution timed out after 90s: …`). The string is the part of the result
 * that survives every boundary the error crosses (dynamic worker RPC,
 * persisted invocation responses, `UserCodeError` rethrows), so downstream
 * consumers can report the actual budget without guessing the run context.
 */
export function createExecutorSandboxTimeoutMessage(timeoutMs: number) {
	return `${executorSandboxTimeoutMessagePrefix} after ${formatTimeoutBudget(timeoutMs)}${executorSandboxTimeoutMessageExplanation}`
}

function throwIfEvaluationDeadlineAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return
	const reason = signal.reason
	if (reason instanceof Error) throw reason
	throw new Error(executorSandboxTimeoutMessage)
}

async function waitHostEvaluationKeepAliveMs(ms: number) {
	if (
		typeof scheduler !== 'undefined' &&
		typeof scheduler.wait === 'function'
	) {
		await scheduler.wait(ms)
		return
	}
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Abortable delay so a settled evaluate/timeout can stop the keepalive loop
 * without waiting out the full interval (important for short test budgets).
 */
async function waitHostEvaluationKeepAliveInterval(
	ms: number,
	signal: AbortSignal,
) {
	if (signal.aborted) {
		throw new DOMException('The operation was aborted.', 'AbortError')
	}
	await Promise.race([
		waitHostEvaluationKeepAliveMs(ms),
		new Promise<never>((_resolve, reject) => {
			const onAbort = () => {
				reject(new DOMException('The operation was aborted.', 'AbortError'))
			}
			signal.addEventListener('abort', onAbort, { once: true })
			if (signal.aborted) onAbort()
		}),
	])
}

async function keepHostEvaluationRequestAlive(signal: AbortSignal) {
	while (!signal.aborted) {
		try {
			await waitHostEvaluationKeepAliveInterval(
				hostEvaluationKeepAliveIntervalMs,
				signal,
			)
		} catch {
			return
		}
	}
}

/**
 * Host-side deadline around Worker Loader `evaluate` (and its permit wait).
 * The sandbox also races an internal timer, but that only helps once the
 * dynamic worker is running and can schedule timers. If `evaluate` never
 * returns (or never starts), this host race is what bounds the request and
 * lets run-record finish write an error instead of leaving `running` forever.
 *
 * The AbortSignal is shared with the permit queue so a timed-out waiter is
 * removed and cannot start `evaluate` after `execute` has already returned.
 *
 * A parallel `scheduler.wait` keepalive keeps the host IoContext alive when
 * the dynamic worker awaits a never-settling Promise with an empty event
 * loop. Without it, Cloudflare hang-detects the host (~20s) before this
 * deadline can fire, cancels JobManager's HOST RPC, and leaves the scheduled
 * run stranded as `running` (KODY-AB).
 */
export async function raceWithHostEvaluationDeadline<T>(
	evaluate: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<T> {
	if (
		!externalSignal &&
		(!Number.isFinite(timeoutMs) || timeoutMs >= maxSupportedExecutorTimeoutMs)
	) {
		return await evaluate(new AbortController().signal)
	}
	const controller = new AbortController()
	const keepaliveController = new AbortController()
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	let rejectDeadline: ((error: Error) => void) | undefined
	const abortWith = (error: Error) => {
		if (controller.signal.aborted) return
		controller.abort(error)
		rejectDeadline?.(error)
	}
	const onExternalAbort = () => {
		const reason = externalSignal?.reason
		// A caller disconnect must not be relabeled as the sandbox wall-clock
		// timeout. Only a real Error reason (AbortError, or an upstream
		// timeout) is forwarded; a bare abort is the inbound request ending.
		if (reason instanceof Error) {
			abortWith(reason)
			return
		}
		abortWith(new DOMException(callerDisconnectedSandboxMessage, 'AbortError'))
	}
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject
		if (
			Number.isFinite(timeoutMs) &&
			timeoutMs < maxSupportedExecutorTimeoutMs
		) {
			timeoutId = setTimeout(
				() =>
					abortWith(
						new HostEvaluationTimeoutError<T>(
							createExecutorSandboxTimeoutMessage(timeoutMs),
						),
					),
				Math.max(1, timeoutMs),
			)
		}
		if (externalSignal) {
			externalSignal.addEventListener('abort', onExternalAbort, { once: true })
			if (externalSignal.aborted) onExternalAbort()
		}
	})
	const evaluationPromise = Promise.resolve().then(
		async () => await evaluate(controller.signal),
	)
	const keepalivePromise = keepHostEvaluationRequestAlive(
		keepaliveController.signal,
	)
	try {
		return await Promise.race([evaluationPromise, timeoutPromise])
	} catch (error) {
		if (error instanceof HostEvaluationTimeoutError) {
			const drained = await settleWithin(
				evaluationPromise,
				hostEvaluationDrainGraceMs,
			)
			if (drained.status === 'fulfilled') {
				error.evaluationResult = drained.value
			}
		}
		throw error
	} finally {
		keepaliveController.abort()
		await settleWithin(keepalivePromise, hostEvaluationDrainGraceMs)
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
		externalSignal?.removeEventListener('abort', onExternalAbort)
		rejectDeadline = undefined
	}
}

async function settleWithin<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<PromiseSettledResult<T> | { status: 'timed-out' }> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise.then(
				(value): PromiseFulfilledResult<T> => ({
					status: 'fulfilled',
					value,
				}),
				(reason): PromiseRejectedResult => ({
					status: 'rejected',
					reason,
				}),
			),
			new Promise<{ status: 'timed-out' }>((resolve) => {
				timeoutId = setTimeout(
					() => resolve({ status: 'timed-out' }),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

export function createNamedExecutionError(error: unknown) {
	const message = getErrorMessage(error)
	if (isCallerDisconnectedSandboxMessage(message)) {
		return createCallerDisconnectedExecutionError()
	}
	const namedError = new Error(message)
	if (isExecutorSandboxTimeoutMessage(message)) {
		namedError.name = 'TimeoutError'
	}
	return namedError
}

export function createKodyRemoteProxy(input: {
	entries: Array<
		Pick<KodyMcpServerMetadata, 'name' | 'status' | 'capabilities'>
	>
	callTool: (dispatchName: string, args: unknown) => Promise<unknown>
	entityLabel?: string
	shortEntityLabel?: string
	capabilityLabel?: string
}) {
	const entityLabel = input.entityLabel ?? 'MCP server'
	const shortEntityLabel = input.shortEntityLabel ?? 'MCP server'
	const capabilityLabel = input.capabilityLabel ?? 'MCP tool'
	type ConnectorEntry = (typeof input.entries)[number] & {
		capabilitiesByName: Map<
			string,
			(typeof input.entries)[number]['capabilities'][number]
		>
	}
	const connectors = new Map<string, ConnectorEntry>(
		input.entries.map((connector) => [
			connector.name,
			{
				...connector,
				capabilitiesByName: new Map(
					connector.capabilities.map((capability) => [
						capability.name,
						capability,
					]),
				),
			} satisfies ConnectorEntry,
		]),
	)
	const formatNames = (names: Array<string>) =>
		names.length > 0
			? names.map((name) => JSON.stringify(name)).join(', ')
			: 'none'
	const isProxyLookupKey = (name: string | symbol) =>
		typeof name === 'symbol' || name === 'then'
	const createReflectingProxy = (
		knownKeys: Array<string>,
		getValue: (name: string) => unknown,
	) =>
		new Proxy(
			{},
			{
				get(_target, name) {
					if (isProxyLookupKey(name)) return undefined
					return getValue(String(name))
				},
				has(_target, name) {
					if (isProxyLookupKey(name)) return false
					return knownKeys.includes(String(name))
				},
				ownKeys() {
					return [...knownKeys]
				},
				getOwnPropertyDescriptor(_target, name) {
					if (isProxyLookupKey(name)) return undefined
					return {
						configurable: true,
						enumerable: true,
						writable: true,
						value: getValue(String(name)),
					}
				},
			},
		)

	const createCapabilityProxy = (
		connector: ConnectorEntry,
		connectorName: string,
	) =>
		createReflectingProxy(
			connector.capabilities.map((capability) => capability.name),
			(capabilityName) => {
				const capability = connector.capabilitiesByName.get(capabilityName)
				if (!capability) {
					if (!connector.status.connected || connector.status.toolCount === 0) {
						throw new Error(connector.status.unavailableMessage)
					}
					throw new Error(
						`Unknown ${capabilityLabel} "${capabilityName}" for ${shortEntityLabel} "${connectorName}". Available capabilities: ${formatNames(connector.capabilities.map((entry) => entry.name))}.`,
					)
				}
				return async (args: unknown) => {
					if (!connector.status.connected || connector.status.toolCount === 0) {
						throw new Error(connector.status.unavailableMessage)
					}
					return await input.callTool(capability.dispatchName, args)
				}
			},
		)

	return createReflectingProxy([...connectors.keys()], (connectorName) => {
		const connector = connectors.get(connectorName)
		if (!connector) {
			throw new Error(
				`Unknown ${entityLabel} "${connectorName}". Available ${entityLabel}s: ${formatNames([...connectors.keys()])}.`,
			)
		}
		return createCapabilityProxy(connector, connectorName)
	})
}

export function createExecuteExecutor(input: {
	env: Env
	exports?: WorkerLoopbackExports
	gatewayProps: FetchGatewayProps
	modules?: WorkerLoaderModules
	timeoutMs?: number | null
	signal?: AbortSignal
	/**
	 * Optional sink for literal hostnames observed on ad hoc execute raw
	 * `fetch` traffic. Counting happens inside the sandbox (so LOADER keeps a
	 * real Fetcher for globalOutbound). Package-context runs should omit this
	 * so saved-package outbound requests are not counted.
	 */
	rawFetchHostSink?: RawFetchHostSink
	/**
	 * When false, skip the `execute` usage event. Nested surfaces (jobs,
	 * package exports, workflows) already record their own metrics.
	 * Defaults to true for ad-hoc executor callers.
	 */
	recordExecuteUsage?: boolean
	/**
	 * Surface that minted this Dynamic Worker. Defaults to `execute` for
	 * ad-hoc executor callers. Nested surfaces pass the mapped UWD tag.
	 */
	surface?: DynamicWorkerDaySurface
	/**
	 * Saved package id when this worker belongs to a known package run.
	 * Omit for ad hoc execute; never guess.
	 */
	packageId?: string | null
	/**
	 * Host-side thin/glue class for ad-hoc execute usage events. Omit on
	 * nested surfaces.
	 */
	executeShape?: ExecuteThinGlueClass | null
	/**
	 * Called once the stable LOADER worker id is minted (same id unique_worker_days
	 * meters). Use to stamp run metadata before evaluate finishes.
	 */
	onWorkerId?: (workerId: string) => void
	/** Capped unique-worker-day claim awaited before load (hosted execute). */
	claimWorkerDay?: ClaimWorkerDay
	/**
	 * When set, unique-worker-day metering and the first-execute activation
	 * stamp run on `waitUntil` instead of the sandbox critical path.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const loopbackExports = input.exports ?? workerExports
	if (!loopbackExports?.KodyFetchGateway) {
		throw new Error(
			'KodyFetchGateway export is required for execute-time fetch.',
		)
	}
	const timeout =
		input.timeoutMs === null
			? maxSupportedExecutorTimeoutMs
			: (input.timeoutMs ?? defaultExecutorTimeoutMs)
	const gatewayProps = input.gatewayProps
	return createStableDynamicWorkerExecutor({
		loader: input.env.LOADER,
		timeout,
		signal: input.signal,
		// Shared by every evaluate on this isolate; run fetch uses createRunFetcher.
		globalOutbound: loopbackExports.KodyFetchGateway({
			props: {} as FetchGatewayProps,
		}),
		createRunFetcher: () =>
			loopbackExports.KodyFetchGateway({ props: gatewayProps }),
		createPackageFetcher: (packageId: string) =>
			loopbackExports.KodyFetchGateway({
				props: { ...gatewayProps, boundPackageId: packageId },
			}),
		// Tails only run where Analytics Engine is bound (deployed Workers).
		// Open-source workerd reports zero CPU, and a local tail would outlive
		// the run with a D1 write per invocation.
		...('DynamicWorkerUsageTail' in loopbackExports && input.env.USAGE_EVENTS
			? {
					createUsageTail: (props: DynamicWorkerUsageTailProps) =>
						loopbackExports.DynamicWorkerUsageTail({ props }),
				}
			: {}),
		modules: input.modules,
		gatewayProps,
		usageEnv: input.env,
		rawFetchHostSink: input.rawFetchHostSink,
		recordExecuteUsage: input.recordExecuteUsage,
		surface: input.surface ?? 'execute',
		packageId: input.packageId,
		executeShape: input.executeShape,
		onWorkerId: input.onWorkerId,
		claimWorkerDay: input.claimWorkerDay,
		waitUntil: input.waitUntil,
	})
}

function createStableDynamicWorkerExecutor(input: DynamicWorkerExecutorInput) {
	const modules = removeReservedExecutorModule(input.modules)
	return {
		async execute(
			code: string,
			providers: Array<ResolvedProvider>,
			invocation?: DynamicWorkerEvaluateInvocation,
		): Promise<ExecuteResultWithHostSideEffects> {
			const sideEffects = createEvaluationSideEffectTracker()
			const validationError = validateProviders(providers)
			if (validationError) {
				return attachHostSideEffects(
					{
						result: undefined,
						error: validationError,
					},
					sideEffects,
				)
			}
			const excludedHostname = readBaseUrlHostname(input.gatewayProps.baseUrl)
			const evaluateInvocation = resolveEvaluateInvocation(
				providers,
				invocation,
			)
			const normalizeCode = await loadNormalizeCode()
			const executorModule = createExecutorModule({
				normalizedCode: normalizeCode(code),
				providers,
				shadowGlobalThis: Object.keys(modules).length === 0,
				timeoutMs: input.timeout,
				excludedHostname,
			})
			const workerOptions = {
				...createDynamicWorkerCompatibilityOptions(),
				mainModule: dynamicWorkerMainModule,
				modules: {
					...modules,
					[dynamicWorkerMainModule]: executorModule,
				},
				globalOutbound: input.globalOutbound,
			}
			const workerId = await createStableDynamicWorkerId({
				userId: input.gatewayProps.userId,
				storageContext: input.gatewayProps.storageContext,
				workerOptions,
			})
			input.onWorkerId?.(workerId)
			const attributedPackageId =
				input.packageId?.trim() ||
				invocation?.packageContext?.packageId?.trim() ||
				null
			const dayAttribution: ClaimWorkerDayAttribution = {
				...(attributedPackageId ? { packageId: attributedPackageId } : {}),
				...usageConnectionFieldsFromRequest(input.gatewayProps.request),
			}
			let claimedDay: Promise<{ created: boolean } | undefined>
			if (input.claimWorkerDay) {
				claimedDay = Promise.resolve(
					await input.claimWorkerDay(workerId, dayAttribution),
				)
			} else {
				claimedDay = recordUniqueDynamicWorkerDay({
					env: input.usageEnv,
					userId: input.gatewayProps.userId,
					workerId,
					surface: input.surface ?? 'execute',
					...dayAttribution,
				})
				await runExecuteBookkeeping(
					claimedDay,
					input.waitUntil,
					'dynamic-worker-day-record-failed',
				)
			}
			const codeChars = countDynamicWorkerModuleGraphChars(
				workerOptions.modules,
			)
			const paramsChars = countEvaluateInvocationParamsChars(
				evaluateInvocation.params,
			)
			const executionState = { active: true }
			const startedAtMs = Date.now()
			let outcome: 'success' | 'error' = 'success'
			try {
				const usageUserId = input.gatewayProps.userId
				const usageTail =
					usageUserId && input.createUsageTail
						? input.createUsageTail({ userId: usageUserId, workerId })
						: null
				// LOADER.get keeps the first WorkerCode cached for an id, so an
				// isolate loaded without a tail would never gain one under the
				// same id. Tailed isolates get their own cache id; metering keeps
				// `workerId`.
				const loaderId = usageTail
					? `${workerId}${dynamicWorkerUsageTailLoaderIdSuffix}`
					: workerId
				const entrypoint = input.loader
					.get(loaderId, () =>
						usageTail
							? { ...workerOptions, tails: [usageTail] }
							: workerOptions,
					)
					.getEntrypoint() as unknown as DynamicWorkerEntrypoint
				let response: Awaited<ReturnType<DynamicWorkerEntrypoint['evaluate']>>
				try {
					response = await raceWithHostEvaluationDeadline(
						async (signal) =>
							await withDynamicWorkerEvaluationPermit(async () => {
								throwIfEvaluationDeadlineAborted(signal)
								// Capture grants into dispatchers: sandbox → host
								// capability RPC loses AsyncLocalStorage (same gap
								// as evaluation-budget restore). Without this,
								// runWithCurrentSecretAuthority reinstalls an empty
								// grant set and stamped MCP/integration calls fail
								// closed for package-via-execute.
								const grantedSecretAuthorityPackageIds =
									grantedSecretAuthorityPackageIdSet(
										input.gatewayProps.grantedSecretAuthorityPackageIds,
									)
								const dispatchers = createToolDispatchers(
									[...providers, createHostSideEffectProvider(sideEffects)],
									executionState,
									signal,
									sideEffects,
									grantedSecretAuthorityPackageIds,
								)
								const packageBindings = createPackageBindingStubs({
									grantedPackageIds: grantedSecretAuthorityPackageIds,
									createPackageFetcher: input.createPackageFetcher,
									providers,
									executionState,
									signal,
									sideEffects,
								})
								const evaluate = () =>
									entrypoint.evaluate(
										dispatchers,
										evaluateInvocation,
										packageBindings,
										input.createRunFetcher?.() ?? null,
									)
								return grantedSecretAuthorityPackageIds
									? await runWithSecretAuthorityScope(
											grantedSecretAuthorityPackageIds,
											evaluate,
										)
									: await evaluate()
							}, signal),
						input.timeout,
						input.signal,
					)
				} catch (error) {
					const message = getErrorMessage(error)
					if (isExecutorSandboxTimeoutMessage(message)) {
						outcome = 'error'
						const drainedResponse =
							error instanceof HostEvaluationTimeoutError
								? (error.evaluationResult as
										| Awaited<ReturnType<DynamicWorkerEntrypoint['evaluate']>>
										| undefined)
								: undefined
						return attachHostSideEffects(
							{
								result: undefined,
								error: drainedResponse?.error ?? message,
								logs: drainedResponse?.logs ?? [],
							},
							sideEffects,
						)
					}
					if (isWorkersHungRequestCanceledError(error)) {
						// Dynamic-worker empty-event-loop hangs surface as this
						// platform cancel. Prefer an owner-readable outcome over
						// rethrowing (which aborts JobManager before claim settle)
						// or returning Cloudflare's cancel string. Scheduled jobs
						// remap to scheduledJobHungExecutionMessage in the jobs layer.
						outcome = 'error'
						return attachHostSideEffects(
							{
								result: undefined,
								error: workersHungExecutionMessage,
								logs: [],
							},
							sideEffects,
						)
					}
					if (error instanceof Error && error.name === 'AbortError') {
						outcome = 'error'
						return attachHostSideEffects(
							{
								result: undefined,
								error: callerDisconnectedSandboxMessage,
								logs: [callerDisconnectedSandboxLog],
							},
							sideEffects,
						)
					}
					if (isTransientDurableObjectResetError(error)) {
						outcome = 'error'
						return attachHostSideEffects(
							{
								result: undefined,
								error: message,
								logs: [],
							},
							sideEffects,
						)
					}
					throw error
				}
				if (input.rawFetchHostSink) {
					for (const hostname of response.rawFetchHosts ?? []) {
						input.rawFetchHostSink.add(hostname)
					}
				}
				if (response.error) {
					outcome = 'error'
					return attachHostSideEffects(
						{
							result: undefined,
							error: response.error,
							logs: response.logs,
						},
						sideEffects,
					)
				}
				return attachHostSideEffects(
					{
						result: response.result,
						logs: response.logs,
					},
					sideEffects,
				)
			} catch (error) {
				outcome = 'error'
				if (isTransientDurableObjectResetError(error)) {
					return attachHostSideEffects(
						{
							result: undefined,
							error: getErrorMessage(error),
							logs: [],
						},
						sideEffects,
					)
				}
				throw error
			} finally {
				executionState.active = false
				const durationMs = Date.now() - startedAtMs
				if (input.gatewayProps.userId) {
					await runExecuteBookkeeping(
						claimedDay.then(async (claimed) => {
							if (!claimed) return
							await recordDynamicWorkerInvoke({
								env: input.usageEnv,
								userId: input.gatewayProps.userId,
								durationMs,
								outcome,
								surface: input.surface ?? 'execute',
								cacheReuse: claimed.created ? 'miss' : 'hit',
								codeChars,
								paramsChars,
								executeShape: input.executeShape,
								...usageAttributionFieldsFromRequest(
									input.gatewayProps.request,
								),
								waitUntil: input.waitUntil,
							})
						}),
						input.waitUntil,
						'dynamic-worker-invoke-record-failed',
					)
				}
				if (input.recordExecuteUsage !== false && input.gatewayProps.userId) {
					await recordUsage(
						input.usageEnv,
						{
							userId: input.gatewayProps.userId,
							eventType: 'execute',
							durationMs,
							outcome,
							surface: 'execute',
							...usageAttributionFieldsFromRequest(input.gatewayProps.request),
							...(input.executeShape
								? { executeShape: input.executeShape }
								: {}),
						},
						{ waitUntil: input.waitUntil },
					)
				}
			}
		},
	}
}

async function runExecuteBookkeeping(
	work: Promise<unknown>,
	waitUntil: ((promise: Promise<unknown>) => void) | undefined,
	warnKey: string,
) {
	const tracked = work.catch((error: unknown) => {
		console.warn(warnKey, error)
	})
	if (waitUntil) {
		waitUntil(tracked)
		return
	}
	await tracked
}

function validateProviders(providers: Array<ResolvedProvider>) {
	const seenNames = new Set<string>()
	for (const provider of providers) {
		if (reservedProviderNames.has(provider.name)) {
			return `Provider name "${provider.name}" is reserved`
		}
		if (!validProviderNamePattern.test(provider.name)) {
			return `Provider name "${provider.name}" is not a valid JavaScript identifier`
		}
		if (javascriptReservedWords.has(provider.name)) {
			return `Provider name "${provider.name}" is a JavaScript reserved word`
		}
		if (seenNames.has(provider.name)) {
			return `Duplicate provider name "${provider.name}"`
		}
		seenNames.add(provider.name)
	}
	return null
}

function createSandboxRunFetchSource() {
	return [
		'    // Generic (unbound) fetch: never carries package secret authority.',
		'    // Package identity travels only on the per-package gateway binding',
		'    // used by module-bound fetch (GHSA-5fv3).',
		'    const __kodyRunFetch = (input, init) => {',
		'      try {',
		'        let url = "";',
		'        if (typeof input === "string") url = input;',
		'        else if (input instanceof URL) url = input.toString();',
		'        else if (input && typeof input.url === "string") url = input.url;',
		'        const hostname = new URL(url).hostname.trim().toLowerCase();',
		'        if (hostname && hostname !== __kodyExcludedFetchHost) {',
		'          __kodyRawFetchHosts.push(hostname);',
		'        }',
		'      } catch {',
		'        // Ignore unparseable / relative URLs; only literal hosts count.',
		'      }',
		'      return (async () => {',
		`        if (__dispatchers.${hostSideEffectProviderName}) {`,
		`          const resJson = await __dispatchers.${hostSideEffectProviderName}.call("recordFetch", "[]");`,
		'          const data = JSON.parse(resJson);',
		'          if (data.error) throw new Error(data.error);',
		'        }',
		'        const __kodyFetchHeaders = new Headers(',
		'          init?.headers ??',
		'            (input && typeof input === "object" && "headers" in input',
		'              ? input.headers',
		'              : undefined),',
		'        );',
		`        __kodyFetchHeaders.delete(${JSON.stringify(secretAuthorityHeaderName)});`,
		'        if (!__kodyRunFetcher) throw new Error("Outbound fetch is unavailable for this run.");',
		'        const __kodyResponse = await __kodyRunFetcher.fetch(input, {',
		'          ...init,',
		'          headers: __kodyFetchHeaders,',
		'        });',
		`        const __kodyPathSegmentWarning = __kodyResponse.headers.get(${JSON.stringify(pathSegmentEncodingWarningHeaderName)});`,
		'        if (__kodyPathSegmentWarning) {',
		'          console.warn(__kodyPathSegmentWarning);',
		'        }',
		'        return __kodyResponse;',
		'      })();',
		'    };',
	]
}

/**
 * Sandbox half of the trusted per-package binding (GHSA-5fv3). Wraps each
 * host binding stub in a frozen record using intrinsics captured at module
 * init, keyed by package id in a Map. The map is passed only to the
 * runtime module's private binding scope by the host wrapper; package code
 * never sees it and cannot name another package's entry.
 */
function createPackageBindingSandboxSource() {
	return [
		'function __kodyCreateSandboxPackageBindings(stubs, hostSideEffects, mcpFactoryRef) {',
		'  const map = new __kodyMapCaptured();',
		'  if (stubs == null || typeof stubs !== "object") return map;',
		'  const recordFetch = async () => {',
		'    if (!hostSideEffects) return;',
		'    const resJson = await hostSideEffects.call("recordFetch", "[]");',
		'    const data = __kodyJsonParseCaptured(resJson);',
		'    if (data.error) throw new __kodyErrorCaptured(data.error);',
		'  };',
		'  for (const packageId of __kodyObjectKeysCaptured(stubs)) {',
		'    const stub = stubs[packageId];',
		'    if (stub == null || typeof stub !== "object") continue;',
		'    const fetcher = stub.fetcher ?? null;',
		'    const kodyStub = stub.kody ?? null;',
		'    const kodyCall = async (dispatchName, args) => {',
		'      if (!kodyStub) {',
		'        throw new __kodyErrorCaptured("kody:runtime is not available in this execution context.");',
		'      }',
		'      const payload = args == null || typeof args !== "object" || __kodyArrayIsArrayCaptured(args) ? (args ?? {}) : { ...args };',
		`      if (payload && typeof payload === "object") delete payload[${JSON.stringify(secretAuthorityArgName)}];`,
		'      const resJson = await kodyStub.call(dispatchName, __kodyJsonStringifyCaptured(payload));',
		'      const data = __kodyJsonParseCaptured(resJson);',
		'      if (data.error) throw new __kodyErrorCaptured(data.error);',
		'      return data.result;',
		'    };',
		'    let mcp = null;',
		'    const binding = __kodyObjectFreezeCaptured({',
		'      kodyMcp: () => {',
		'        if (mcp == null && typeof mcpFactoryRef?.create === "function") mcp = mcpFactoryRef.create(kodyCall);',
		'        return mcp;',
		'      },',
		'      fetch: async (input, init) => {',
		'        if (!fetcher) throw new __kodyErrorCaptured("Outbound fetch is unavailable for this package.");',
		'        await recordFetch();',
		'        return await fetcher.fetch(input, init);',
		'      },',
		'      kodyCall: (dispatchName, args) => kodyCall(dispatchName, args),',
		// packageStorage() for this package only: the host bound dispatcher
		// stamps this package, so the bucket cannot be chosen by the caller.
		'      packageStorageCall: async (toolName, args) => await kodyCall(toolName, args),',
		// credential() for this package only: needs, mappings, and bound Keys
		// resolve as the stamped package, never a sandbox-named id.
		'      credentialCall: async (toolName, args) => await kodyCall(toolName, args),',
		'      packageSecretGet: async (alias) => {',
		'        const result = await kodyCall("packageSecretGet", { alias });',
		'        return typeof result?.value === "string" ? result.value : "";',
		'      },',
		'      packageSecretHas: async (alias) => {',
		'        const result = await kodyCall("packageSecretHas", { alias });',
		'        return result?.has === true;',
		'      },',
		'    });',
		'    __kodyReflectApplyCaptured(__kodyMapSetCaptured, map, [packageId, binding]);',
		'  }',
		'  return map;',
		'}',
	]
}

function createExecutorModule(input: {
	normalizedCode: string
	providers: Array<ResolvedProvider>
	shadowGlobalThis: boolean
	timeoutMs: number
	excludedHostname?: string
}) {
	const normalized = input.normalizedCode
	const excludedHostname = JSON.stringify(input.excludedHostname ?? '')
	const sandboxGlobalLines = input.shadowGlobalThis
		? [
				'    const __kodySandboxGlobalValues = Object.create(null);',
				'    const __kodySandboxGlobal = new Proxy(globalThis, {',
				'      get(target, property) {',
				'        return property in __kodySandboxGlobalValues ? __kodySandboxGlobalValues[property] : target[property];',
				'      },',
				'      set(_target, property, value) {',
				'        __kodySandboxGlobalValues[property] = value;',
				'        return true;',
				'      },',
				'      has(target, property) {',
				'        return property in __kodySandboxGlobalValues || property in target;',
				'      },',
				'    });',
			]
		: []
	// Empty module graphs inline the snippet into evaluate(). Shadow the
	// capability dispatcher (and the RPC bag it closes over) so that snippet
	// cannot call tools. Do not shadow `kody`: a bare reference must stay a
	// ReferenceError so the import hint still fires. Bundled executes skip
	// this wrapper; their host prelude calls the dispatcher from the outer
	// scope.
	const oneFileHiddenBindings = [
		'__kodyPackageBindings',
		'__kodyPackageBindingStubs',
		'__kodyPackageMcpFactoryRef',
		kodyCallDispatcherName,
		kodyProviderEvaluateBindingName,
		'__kodyMcp',
		'__kodyCreateRemoteProxy',
		'__dispatchers',
	]
	const userCodeInvocation = input.shadowGlobalThis
		? [
				`        (async (globalThis, self, global, ${oneFileHiddenBindings.join(', ')}) => (`,
				normalized,
				')(__invocation))(__kodySandboxGlobal, __kodySandboxGlobal, __kodySandboxGlobal),',
			]
		: ['        (', normalized, ')(__invocation),']
	return [
		'import { WorkerEntrypoint } from "cloudflare:workers";',
		'import { AsyncLocalStorage } from "node:async_hooks";',
		'',
		'const __kodyEvaluateFetchStorageSymbol = Symbol.for("kody.evaluateFetchStorage");',
		'const __kodyEvaluateFetchPatchedSymbol = Symbol.for("kody.evaluateFetchPatched");',
		'const __kodyRuntimeStorageSymbol = Symbol.for("kody.runtimeStorage");',
		'const __kodyEvaluateConsoleStorageSymbol = Symbol.for("kody.evaluateConsoleStorage");',
		'const __kodyNativeConsoleSymbol = Symbol.for("kody.nativeConsole");',
		'// Capture before any package code can patch intrinsics (GHSA-5fv3).',
		'const __kodyReflectApplyCaptured = Reflect.apply;',
		'const __kodyAlsGetStoreCaptured = AsyncLocalStorage.prototype.getStore;',
		'const __kodyObjectKeysCaptured = Object.keys;',
		'const __kodyObjectFreezeCaptured = Object.freeze;',
		'const __kodyMapCaptured = Map;',
		'const __kodyMapSetCaptured = Map.prototype.set;',
		'const __kodyJsonParseCaptured = JSON.parse;',
		'const __kodyJsonStringifyCaptured = JSON.stringify;',
		'const __kodyErrorCaptured = Error;',
		'const __kodyArrayIsArrayCaptured = Array.isArray;',
		...createPackageBindingSandboxSource(),
		'const __kodyNativeFetch = globalThis.fetch.bind(globalThis);',
		'const __kodyEvaluateFetchStorage =',
		'  globalThis[__kodyEvaluateFetchStorageSymbol] ??',
		'  (globalThis[__kodyEvaluateFetchStorageSymbol] = new AsyncLocalStorage());',
		'if (!globalThis[__kodyEvaluateFetchPatchedSymbol]) {',
		'  globalThis.fetch = (input, init) => {',
		'    const ctx = __kodyReflectApplyCaptured(__kodyAlsGetStoreCaptured, __kodyEvaluateFetchStorage, []);',
		'    if (ctx) return ctx.fetch(input, init);',
		'    return __kodyNativeFetch(input, init);',
		'  };',
		'  globalThis[__kodyEvaluateFetchPatchedSymbol] = true;',
		'}',
		'const __kodyEvaluateConsoleStorage =',
		'  globalThis[__kodyEvaluateConsoleStorageSymbol] ??',
		'  (globalThis[__kodyEvaluateConsoleStorageSymbol] = new AsyncLocalStorage());',
		'const __kodyNativeConsole =',
		'  globalThis[__kodyNativeConsoleSymbol] ??',
		'  (globalThis[__kodyNativeConsoleSymbol] = globalThis.console);',
		'const __kodyCaptureConsole = (method, prefix) => (...a) => {',
		'  const ctx = __kodyReflectApplyCaptured(__kodyAlsGetStoreCaptured, __kodyEvaluateConsoleStorage, []);',
		'  if (ctx?.active) { ctx.logs.push(prefix + a.map(String).join(" ")); return; }',
		'  return __kodyReflectApplyCaptured(__kodyNativeConsole[method], __kodyNativeConsole, a);',
		'};',
		'// A fresh console per call undoes user overwrites from earlier calls.',
		'// Logs route by AsyncLocalStorage, so overlapping calls stay separate.',
		'const __kodyCreateCaptureConsole = () => ({',
		'  ...__kodyNativeConsole,',
		'  log: __kodyCaptureConsole("log", ""),',
		'  info: __kodyCaptureConsole("info", "[info] "),',
		'  debug: __kodyCaptureConsole("debug", "[debug] "),',
		'  warn: __kodyCaptureConsole("warn", "[warn] "),',
		'  error: __kodyCaptureConsole("error", "[error] "),',
		'});',
		'',
		'export default class CodeExecutor extends WorkerEntrypoint {',
		'  async evaluate(__dispatchers = {}, __invocation = {}, __kodyPackageBindingStubs = null, __kodyRunFetcher = null) {',
		'    const __logs = [];',
		'    const __kodyRawFetchHosts = [];',
		`    const __kodyExcludedFetchHost = ${excludedHostname};`,
		...createSandboxRunFetchSource(),
		'    const __kodyPackageMcpFactoryRef = { create: null };',
		`    const __kodyPackageBindings = __kodyCreateSandboxPackageBindings(__kodyPackageBindingStubs, __dispatchers.${hostSideEffectProviderName} ?? null, __kodyPackageMcpFactoryRef);`,
		'    const __kodyConsoleContext = { logs: __logs, active: true };',
		'    globalThis.console = __kodyCreateCaptureConsole();',
		'    return __kodyEvaluateConsoleStorage.run(__kodyConsoleContext, () => __kodyEvaluateFetchStorage.run({ fetch: __kodyRunFetch }, async () => {',
		...sandboxGlobalLines,
		// Keep this aligned with upstream kody's sandbox dispatcher shape:
		// the dynamic worker source only names provider namespaces, while the
		// actual per-invocation tool implementations arrive through RPC dispatchers.
		...input.providers.map((provider) => createProviderProxySource(provider)),
		// Package-bound kody.mcp (GHSA-5fv3): same MCP proxy, dispatched
		// through that package's trusted binding so package-locked MCP
		// servers see the package's own identity.
		...(input.providers.some((provider) => provider.name === 'kody')
			? [
					'    __kodyPackageMcpFactoryRef.create = (callTool) => __kodyCreateRemoteProxy({',
					'      entries: Array.isArray(__invocation.mcpServers) ? __invocation.mcpServers : [],',
					'      entityLabel: "MCP server",',
					'      shortEntityLabel: "MCP server",',
					'      capabilityLabel: "MCP tool",',
					'      callTool,',
					'    });',
				]
			: []),
		'',
		'    let __timeoutId;',
		'    try {',
		'      const __timeoutPromise = new Promise((_, reject) => {',
		`        __timeoutId = setTimeout(() => reject(new Error(${JSON.stringify(createExecutorSandboxTimeoutMessage(input.timeoutMs))})), ${input.timeoutMs});`,
		'      });',
		'      const result = await Promise.race([',
		...userCodeInvocation,
		'        __timeoutPromise',
		'      ]);',
		'      return { result, logs: __logs, rawFetchHosts: __kodyRawFetchHosts };',
		'    } catch (err) {',
		'      return { result: undefined, error: err.message, logs: __logs, rawFetchHosts: __kodyRawFetchHosts };',
		'    } finally {',
		'      clearTimeout(__timeoutId);',
		'      __kodyConsoleContext.active = false;',
		'    }',
		'    }));',
		'  }',
		'}',
	].join('\n')
}

export async function createExecutorModuleSource({
	code,
	...input
}: {
	code: string
	providers: Array<ResolvedProvider>
	shadowGlobalThis: boolean
	timeoutMs: number
	excludedHostname?: string
}) {
	const normalizeCode = await loadNormalizeCode()
	return createExecutorModule({ ...input, normalizedCode: normalizeCode(code) })
}

function createProviderProxySource(provider: ResolvedProvider) {
	if (provider.name === 'kody') {
		return createKodyProviderProxySource({
			providerName: provider.name,
		})
	}
	return `    const ${provider.name} = new Proxy({}, {\n      get: (_, toolName) => async (...args) => {\n        const resJson = await __dispatchers.${provider.name}.call(String(toolName), JSON.stringify(args));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`
}

/**
 * One trusted binding per package in the run's grant set (GHSA-5fv3): a
 * gateway fetcher and a `kody` capability dispatcher whose secret authority
 * is fixed to that package on the host. Sandbox code never chooses the id.
 */
function createPackageBindingStubs(input: {
	grantedPackageIds: ReadonlySet<string> | null
	createPackageFetcher?: (packageId: string) => Fetcher
	providers: Array<ResolvedProvider>
	executionState: { active: boolean }
	signal?: AbortSignal
	sideEffects?: EvaluationSideEffectTracker
}): PackageBindingStubs | null {
	if (!input.grantedPackageIds || input.grantedPackageIds.size === 0) {
		return null
	}
	const kodyProvider = input.providers.find(
		(provider) => provider.name === 'kody',
	)
	const bindings: PackageBindingStubs = {}
	for (const packageId of input.grantedPackageIds) {
		const kody = kodyProvider
			? createToolDispatchers(
					[kodyProvider],
					input.executionState,
					input.signal,
					input.sideEffects,
					input.grantedPackageIds,
					{ boundPackageId: packageId },
				).kody
			: null
		bindings[packageId] = {
			fetcher: input.createPackageFetcher?.(packageId) ?? null,
			kody: kody ?? null,
		}
	}
	return bindings
}

export function createToolDispatchers(
	providers: Array<ResolvedProvider>,
	executionState: { active: boolean },
	signal?: AbortSignal,
	sideEffects?: EvaluationSideEffectTracker,
	/**
	 * Provenance grant set captured from gateway props. Reinstalled on every
	 * dispatcher call because Workers RPC drops the host ALS that wraps
	 * `evaluate`. Omit (null/undefined) for trusted host callers that are not
	 * crossing the sandbox boundary.
	 */
	grantedSecretAuthorityPackageIds?: ReadonlySet<string> | null,
	/**
	 * Trusted per-package binding (GHSA-5fv3): every call through these
	 * dispatchers runs with this package's secret authority. Generic
	 * dispatchers omit it and run with the run package's authority only;
	 * a sandbox-supplied authority field is always discarded.
	 */
	binding?: { boundPackageId: string } | null,
) {
	const boundPackageId = binding?.boundPackageId?.trim() || null
	if (
		boundPackageId &&
		!grantedSecretAuthorityPackageIds?.has(boundPackageId)
	) {
		throw new Error('Bound package id is not in the run grant set.')
	}
	const capturedEvaluationContext = getDynamicWorkerEvaluationContext()
	const capturedGrantedPackageIds = grantedSecretAuthorityPackageIds ?? null
	const dispatchers: Record<string, ToolDispatcher> = {}
	for (const provider of providers) {
		const sanitizedFns: Record<
			string,
			(...args: Array<unknown>) => Promise<unknown>
		> = {}
		const rawNamesBySanitizedName = new Map<string, string>()
		const abortSignalToolNames = new Set(
			(
				provider as ResolvedProvider & {
					abortSignalToolNames?: Array<string>
				}
			).abortSignalToolNames ?? [],
		)
		for (const [name, fn] of Object.entries(provider.fns)) {
			const sanitizedName = sanitizeToolName(name)
			if (rawNamesBySanitizedName.has(sanitizedName)) {
				const existingName = rawNamesBySanitizedName.get(sanitizedName) ?? ''
				throw new Error(
					`Provider "${provider.name}" has tool names "${existingName}" and "${name}" that both sanitize to "${sanitizedName}".`,
				)
			}
			rawNamesBySanitizedName.set(sanitizedName, name)
			sanitizedFns[sanitizedName] = async (...rawArgs) => {
				// Discard any sandbox-supplied authority field (GHSA-5fv3).
				const { args } = takeSecretAuthorityFromCapabilityArgs(rawArgs)
				const requestedPackageId = boundPackageId
				return await runWithCapturedDynamicWorkerEvaluationContext(
					capturedEvaluationContext,
					async () => {
						if (!executionState.active) {
							throw new Error('Execution has already completed.')
						}
						if (
							sideEffects &&
							!isPlatformOnlyHostSideEffectProvider(provider.name)
						) {
							sideEffects.recordDispatcherAttempt()
						}
						const invoke = () =>
							abortSignalToolNames.has(name) ? fn(...args, signal) : fn(...args)
						// Mirror package-app callCapability: restore grants then
						// stamp. Without grants, a peeled stamp installs an empty
						// set and resolveCallerSecretAuthority fails closed.
						const withStamp = () =>
							runWithCurrentSecretAuthority(requestedPackageId, invoke)
						return capturedGrantedPackageIds
							? await runWithSecretAuthorityScope(
									capturedGrantedPackageIds,
									withStamp,
								)
							: await withStamp()
					},
				)
			}
		}
		dispatchers[provider.name] = new ToolDispatcher(sanitizedFns)
	}
	return dispatchers
}

function removeReservedExecutorModule(
	modules: WorkerLoaderModules | undefined,
) {
	const { [dynamicWorkerMainModule]: _ignored, ...safeModules } = modules ?? {}
	return safeModules
}

export type ExecutionErrorDetails =
	| {
			kind: 'host_approval_required'
			message: string
			nextStep: string
			approvalUrl: string | null
			host: string | null
			secretNames: Array<string>
			suggestedAction: {
				type: 'approve_secret_host'
			}
	  }
	| {
			kind: 'host_approval_required_batch'
			message: string
			nextStep: string
			missingApprovals: Array<{
				secretName: string
				host: string
				approvalUrl: string
			}>
			bulkApprovalUrl: string | null
			suggestedAction: {
				type: 'approve_secret_host'
			}
	  }
	| {
			kind: 'secret_package_access_required'
			message: string
			nextStep: string
			secretNames: Array<string>
			packageName: string
			approvalUrl: string | null
			suggestedAction: {
				type: 'edit_secret_policy'
				policyField: 'allowed_packages'
			}
	  }
	| {
			kind: 'secret_package_access_required_batch'
			message: string
			nextStep: string
			missingApprovals: Array<{
				secretName: string
				packageId: string
				kodyId: string | null
				approvalUrl: string
			}>
			bulkApprovalUrl: string | null
			suggestedAction: {
				type: 'edit_secret_policy'
				policyField: 'allowed_packages'
			}
	  }
	| {
			kind: 'secret_scope_unavailable'
			message: string
			nextStep: string
			secretNames: Array<string>
			scope: SecretScope
			packageName: string | null
			packageId: string | null
			editorUrl: string | null
			missingPackageContext: boolean
			suggestedAction:
				| {
						type: 'edit_secret_policy'
						policyField: 'scope'
				  }
				| {
						type: 'republish_package'
				  }
				| null
	  }
	| {
			kind: 'secret_required'
			message: string
			nextStep: string
			secretNames: Array<string>
			suggestedAction: {
				type: 'connect_secret'
				reason: 'collect_secret'
			}
	  }
	| {
			kind: 'integration_auth_failed'
			message: string
			nextStep: string
			integrationName: string | null
			reconnectHref: string | null
			suggestedAction: {
				type: 'reconnect_integration'
			}
	  }
	| {
			kind: 'auth_required'
			message: string
			nextStep: string
			suggestedAction: {
				type: 'sign_in'
			}
	  }
	| {
			kind: 'runtime_import_missing'
			message: string
			nextStep: string
			exportName: string
			suggestedAction: {
				type: 'fix_code'
			}
	  }
	| {
			kind: 'runtime_helper_unbound'
			message: string
			nextStep: string
			helperName: string
			suggestedAction: {
				type: 'fix_code'
			}
	  }
	| {
			kind: 'entitlement_limit_exceeded'
			message: string
			nextStep: string
			details: EntitlementLimitErrorDetails
			suggestedAction: {
				type: 'review_plan_limit'
				resource: EntitlementLimitErrorDetails['resource']
			}
	  }
	| {
			kind: 'compute_overage_include_reached'
			message: string
			nextStep: string
			details: ComputeOverageLimitErrorDetails
			suggestedAction: {
				type: 'review_plan_limit'
				resource: ComputeOverageLimitErrorDetails['resource']
			}
	  }
	| {
			kind: 'job_interval_floor'
			message: string
			nextStep: string
			suggestedAction: {
				type: 'review_plan_limit'
				resource: 'scheduled_jobs'
			}
	  }
	| {
			kind: 'sandbox_runtime_stale'
			message: string
			nextStep: string
			suggestedAction: {
				type: 'report_bug'
			}
	  }
	| {
			kind: 'dynamic_worker_capacity_exceeded'
			message: string
			nextStep: string
			limit: number
			suggestedAction: {
				type: 'retry'
			}
	  }
	| {
			kind: 'storage_estimate_unavailable'
			message: string
			nextStep: string
			storageId: string
			attempts: number
			suggestedAction: {
				type: 'retry'
			}
	  }
	| {
			kind: 'execution_timed_out'
			message: string
			nextStep: string
			/** Enforced budget parsed from the message; null for legacy budget-less messages. */
			timedOutAfterMs: number | null
			suggestedAction: {
				type: 'fix_code'
			}
	  }

function parseIntegrationTokenRefreshCallerMessage(message: string) {
	const nameMatch = /[Ii]ntegration "([^"]+)"/.exec(message)
	const integrationName = nameMatch?.[1] ?? null
	if (!integrationName) {
		return { integrationName: null, reconnectHref: null }
	}
	return {
		integrationName,
		reconnectHref: buildIntegrationReconnectHref({
			name: integrationName,
			accountLabel: parseTrustedReconnectLoginHint(message, integrationName),
		}),
	}
}

/**
 * Provider `error_description` is interpolated before our generated
 * `Reconnect at /connect/oauth?...` suffix. Only the last root-relative
 * connect path whose provider matches the named integration is trusted.
 */
function parseTrustedReconnectLoginHint(
	message: string,
	integrationName: string,
) {
	let loginHint: string | null = null
	for (const match of message.matchAll(/Reconnect at (\S+)/g)) {
		const raw = match[1]?.replace(/[.)]+$/, '') ?? ''
		if (!raw.startsWith('/connect/oauth?')) continue
		let parsed: URL
		try {
			parsed = new URL(raw, 'https://kody.invalid')
		} catch {
			continue
		}
		if (parsed.origin !== 'https://kody.invalid') continue
		if (parsed.pathname !== '/connect/oauth') continue
		if (parsed.searchParams.get('provider') !== integrationName) continue
		loginHint = parsed.searchParams.get('loginHint')
	}
	return loginHint
}

export function getExecutionErrorDetails(
	error: unknown,
	options: { orgSlug?: string | null } = {},
): ExecutionErrorDetails | null {
	const message = getErrorMessage(error)

	if (isEntitlementLimitError(error)) {
		return toEntitlementExecutionErrorDetails(message, error.details)
	}

	if (isComputeOverageLimitError(error)) {
		return toComputeOverageExecutionErrorDetails(message, error.details)
	}

	if (isJobIntervalFloorError(error)) {
		return {
			kind: 'job_interval_floor',
			message,
			nextStep: error.details.upgradeHint,
			suggestedAction: {
				type: 'review_plan_limit',
				resource: 'scheduled_jobs',
			},
		}
	}

	const entitlementDetails = parseEntitlementLimitMessage(message)
	if (entitlementDetails) {
		return toEntitlementExecutionErrorDetails(message, entitlementDetails)
	}

	const computeDetails = parseComputeOverageLimitMessage(message)
	if (computeDetails) {
		return toComputeOverageExecutionErrorDetails(message, computeDetails)
	}

	const intervalDetails = parseJobIntervalFloorMessage(message)
	if (intervalDetails) {
		return {
			kind: 'job_interval_floor',
			message,
			nextStep: intervalDetails.upgradeHint,
			suggestedAction: {
				type: 'review_plan_limit',
				resource: 'scheduled_jobs',
			},
		}
	}

	const causeMessages = getErrorCauseChain(error).map(getErrorMessage)
	if (causeMessages.some(isDynamicWorkerCapacityErrorMessage)) {
		return {
			kind: 'dynamic_worker_capacity_exceeded',
			message,
			nextStep:
				'Retry the execution. Kody limits dynamic worker evaluations to the platform maximum for each request; if this repeats, report the platform-capacity error.',
			limit: maxConcurrentDynamicWorkerEvaluationsPerRequest,
			suggestedAction: {
				type: 'retry',
			},
		}
	}

	for (const causeMessage of causeMessages) {
		const timeoutDetails = parseExecutorSandboxTimeoutErrorMessage(causeMessage)
		if (timeoutDetails) {
			return {
				kind: 'execution_timed_out',
				message,
				nextStep: createExecutionTimedOutNextStep(
					timeoutDetails.timedOutAfterMs,
				),
				timedOutAfterMs: timeoutDetails.timedOutAfterMs,
				suggestedAction: {
					type: 'fix_code',
				},
			}
		}
	}

	for (const causeMessage of causeMessages) {
		const storageEstimateDetails =
			parseStorageEstimateReadErrorMessage(causeMessage)
		if (storageEstimateDetails) {
			return {
				kind: 'storage_estimate_unavailable',
				message,
				nextStep: `Retry the storage write. Kody could not verify current usage for storageId ${JSON.stringify(storageEstimateDetails.storageId)} after ${storageEstimateDetails.attempts} attempts, so the write was safely blocked.`,
				storageId: storageEstimateDetails.storageId,
				attempts: storageEstimateDetails.attempts,
				suggestedAction: {
					type: 'retry',
				},
			}
		}
	}

	const hostApprovalDetails = parseHostApprovalRequiredMessage(message)
	if (hostApprovalDetails) {
		return {
			kind: 'host_approval_required',
			message,
			nextStep:
				'Ask the user whether they want to approve this host in the account web UI, then retry after approval.',
			approvalUrl: extractFirstUrl(message),
			host: hostApprovalDetails.host,
			secretNames: [hostApprovalDetails.secretName],
			suggestedAction: {
				type: 'approve_secret_host',
			},
		}
	}

	const hostApprovalBatch = parseHostApprovalRequiredBatchMessage(message)
	if (hostApprovalBatch) {
		return {
			kind: 'host_approval_required_batch',
			message,
			nextStep: hostApprovalBatch.bulkApprovalUrl
				? 'Send the user the bulk secret host approval link, wait for them to approve, then retry.'
				: 'Ask the user whether they want to approve these hosts for the listed secrets in the account web UI, then retry after approval.',
			missingApprovals: hostApprovalBatch.entries,
			bulkApprovalUrl: hostApprovalBatch.bulkApprovalUrl,
			suggestedAction: {
				type: 'approve_secret_host',
			},
		}
	}

	const packageAccessBatch = parsePackageAccessRequiredBatchMessage(message)
	if (packageAccessBatch) {
		return {
			kind: 'secret_package_access_required_batch',
			message,
			nextStep: packageAccessBatch.bulkApprovalUrl
				? 'Send the user the bulk package secret approval link, wait for them to approve in the account secrets UI, then retry.'
				: 'Ask the user whether they want to approve these packages for the listed secrets in the account secrets UI, then retry after approval.',
			missingApprovals: packageAccessBatch.entries,
			bulkApprovalUrl: packageAccessBatch.bulkApprovalUrl,
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'allowed_packages',
			},
		}
	}

	const packageAccessDetails = parsePackageAccessRequiredMessage(message)
	if (packageAccessDetails) {
		return {
			kind: 'secret_package_access_required',
			message,
			nextStep:
				"Ask the user whether this package should be allowed to use the secret. If they approve, help them add this package to the secret's allowed packages in the account secrets UI, then retry.",
			secretNames: [packageAccessDetails.secretName],
			packageName: packageAccessDetails.packageName,
			approvalUrl: extractFirstUrl(message),
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'allowed_packages',
			},
		}
	}

	const scopeUnavailableDetails = parseSecretScopeUnavailableMessage(message)
	if (scopeUnavailableDetails) {
		const editorUrl = extractFirstUrl(message)
		if (scopeUnavailableDetails.missingPackageContext) {
			return {
				kind: 'secret_scope_unavailable',
				message,
				nextStep:
					"This runtime belongs to the secret's package but is missing package context. Republish the package so the job/app/webhook gets a fresh package context, then retry. Do not widen the secret scope.",
				secretNames: [scopeUnavailableDetails.secretName],
				scope: scopeUnavailableDetails.scope,
				packageName: scopeUnavailableDetails.packageName,
				packageId: scopeUnavailableDetails.packageId,
				editorUrl,
				missingPackageContext: true,
				suggestedAction: {
					type: 'republish_package',
				},
			}
		}
		return {
			kind: 'secret_scope_unavailable',
			message,
			nextStep:
				scopeUnavailableDetails.scope === 'package'
					? 'This secret exists on a package this runtime cannot see. Prefer invoking the work through an export of the owning package. Changing the secret scope is an explicit, owner-reviewed choice only — ask the account owner before doing that.'
					: 'This secret exists in another scope this runtime cannot see. Prefer retrying from a runtime that can see it. Changing the secret scope is an explicit, owner-reviewed choice only — ask the account owner before doing that.',
			secretNames: [scopeUnavailableDetails.secretName],
			scope: scopeUnavailableDetails.scope,
			packageName: scopeUnavailableDetails.packageName,
			packageId: scopeUnavailableDetails.packageId,
			editorUrl,
			missingPackageContext: false,
			suggestedAction: {
				type: 'edit_secret_policy',
				policyField: 'scope',
			},
		}
	}

	if (isIntegrationTokenRefreshCallerMessage(message)) {
		const parsed = parseIntegrationTokenRefreshCallerMessage(message)
		const reconnectHref = parsed.reconnectHref
		const name = parsed.integrationName
		return {
			kind: 'integration_auth_failed',
			message,
			nextStep: reconnectHref
				? `Send the user to ${reconnectHref} so they can reconnect ${name ?? 'this integration'}, then retry.`
				: 'Ask the user to reconnect this integration from /@<slug>/-/waiting or /@<slug>/-/integrations, then retry.',
			integrationName: name,
			reconnectHref,
			suggestedAction: {
				type: 'reconnect_integration',
			},
		}
	}

	const missingSecretDetails = parseMissingSecretMessage(message)
	if (missingSecretDetails) {
		return {
			kind: 'secret_required',
			message,
			nextStep: `Send the user to ${buildCredentialCreateHref({ orgSlug: options.orgSlug, kind: 'secret', kindMode: 'required', name: missingSecretDetails.secretName })} so they can provide and save this secret, then retry the workflow.`,
			secretNames: [missingSecretDetails.secretName],
			suggestedAction: {
				type: 'connect_secret',
				reason: 'collect_secret',
			},
		}
	}

	if (isSecretAuthRequiredMessage(message)) {
		return {
			kind: 'auth_required',
			message,
			nextStep: 'Ask the user to sign in to Kody, then retry the request.',
			suggestedAction: {
				type: 'sign_in',
			},
		}
	}

	if (isDisposedRpcStubMessage(message)) {
		return {
			kind: 'sandbox_runtime_stale',
			message,
			nextStep:
				'The sandbox reused an RPC stub from an earlier execution, which is a Kody runtime lifecycle bug — retrying the identical call will hit the same cached sandbox worker. Re-run the execute call with a trivially different module (for example, add a comment) so a fresh sandbox is created, and report this error.',
			suggestedAction: {
				type: 'report_bug',
			},
		}
	}

	const unboundRuntimeHelper = parseUnboundRuntimeHelperMessage(message)
	if (unboundRuntimeHelper) {
		return {
			kind: 'runtime_helper_unbound',
			message,
			nextStep: buildUnboundRuntimeHelperNextStep(unboundRuntimeHelper),
			helperName: unboundRuntimeHelper,
			suggestedAction: {
				type: 'fix_code',
			},
		}
	}

	const missingRuntimeExport = parseMissingRuntimeExportMessage(message)
	if (missingRuntimeExport) {
		return {
			kind: 'runtime_import_missing',
			message,
			nextStep: `\`${missingRuntimeExport}\` is provided by the Kody runtime module and must be imported: add \`import { ${missingRuntimeExport} } from 'kody:runtime'\` at the top of the module, then retry.`,
			exportName: missingRuntimeExport,
			suggestedAction: {
				type: 'fix_code',
			},
		}
	}

	return null
}

/**
 * Named exports of the virtual `kody:runtime` module (see
 * `createRuntimeModuleSource` in `#worker/package-runtime/module-graph.ts`).
 * Referencing one without the import throws a bare `X is not defined`
 * ReferenceError that gives no hint about the required import.
 */
const kodyRuntimeExportNames = new Set([
	'kody',
	'packageStorage',
	'createAuthenticatedFetch',
	'secretHeaders',
	'oauthClientCredentials',
	'packageContext',
	'packageSecrets',
	'email',
	'workflows',
	'packages',
	'events',
])

/**
 * workerd throws this when an RPC stub outlives the execution context that
 * created it (stubs passed as RPC parameters are implicitly disposed when the
 * call returns; everything else when the I/O context is destroyed). In the
 * execute pipeline this indicates per-run state leaked into a cached dynamic
 * worker, so surface a structured hint instead of a bare error string.
 */
function isDisposedRpcStubMessage(message: string) {
	return message.includes('RPC stub used after being disposed')
}

/**
 * Recognize `createExecutorSandboxTimeoutMessage` output (and legacy forms:
 * budget-less, explanation-less, or both) at the end of an error message,
 * tolerating wrapper prefixes such as `[execution_failed] ` from package
 * invocation responses. The captured budget lets the structured hint report
 * the actual enforced limit instead of assuming the ad hoc execute default.
 */
const executorSandboxTimeoutDetailsPattern = new RegExp(
	`(?:^|\\s)${executorSandboxTimeoutMessagePrefix}(?: after (\\d+(?:\\.\\d+)?)(m?s))?(?:${escapeRegExp(executorSandboxTimeoutMessageExplanation)})?$`,
)

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseExecutorSandboxTimeoutErrorMessage(message: string) {
	const match = executorSandboxTimeoutDetailsPattern.exec(message)
	if (!match) return null
	const [, amount, unit] = match
	if (!amount) return { timedOutAfterMs: null }
	const value = Number(amount)
	return { timedOutAfterMs: unit === 'ms' ? value : value * 1000 }
}

function createExecutionTimedOutNextStep(timedOutAfterMs: number | null) {
	const budgetSentence =
		timedOutAfterMs === null
			? 'The sandbox enforces a hard execution time budget (~90s for ad hoc execute), so retrying the identical call will time out again.'
			: `The sandbox enforces a hard execution time budget and this run used its full ${formatTimeoutBudget(timedOutAfterMs)}, so retrying the identical call will time out again.`
	return `${budgetSentence} For genuinely long-running work (batch sweeps, migrations, polling loops), have one short execute call submit a durable workflow — \`import { workflows } from 'kody:runtime'\` then \`workflows.create({ code, params })\` — and inspect progress with \`workflowRunList\`. Otherwise split the work into smaller calls that each finish well within the budget.`
}

function formatTimeoutBudget(timeoutMs: number) {
	const seconds = timeoutMs / 1000
	return Number.isInteger(seconds) ? `${seconds}s` : `${timeoutMs}ms`
}

function parseMissingRuntimeExportMessage(message: string) {
	const match = /^(?:ReferenceError: )?(\w+) is not defined\b/.exec(message)
	const exportName = match?.[1]
	return exportName && kodyRuntimeExportNames.has(exportName)
		? exportName
		: null
}

function toEntitlementExecutionErrorDetails(
	message: string,
	details: EntitlementLimitErrorDetails,
): ExecutionErrorDetails {
	return {
		kind: 'entitlement_limit_exceeded',
		message,
		nextStep: details.upgradeHint,
		details,
		suggestedAction: {
			type: 'review_plan_limit',
			resource: details.resource,
		},
	}
}

function toComputeOverageExecutionErrorDetails(
	message: string,
	details: ComputeOverageLimitErrorDetails,
): ExecutionErrorDetails {
	return {
		kind: 'compute_overage_include_reached',
		message,
		nextStep: `${details.whatCounts} ${details.upgradeHint}`,
		details,
		suggestedAction: {
			type: 'review_plan_limit',
			resource: details.resource,
		},
	}
}

export function formatExecutionOutput(result: ExecuteResult) {
	if (result.error) {
		const errorText = getErrorMessage(result.error)
		const details = getExecutionErrorDetails(result.error)
		if (!details) return `Error: ${errorText}`
		return `Error: ${errorText}\n\nNext step: ${details.nextStep}`
	}
	return stringifyExecutionValueForOutput(result.result)
}

export function extractRawContent(value: unknown): Array<ContentBlock> | null {
	return extractMcpPassthrough(value)?.content ?? null
}

function extractFirstUrl(message: string) {
	for (const part of message.split(/\s+/)) {
		if (part.startsWith('http://') || part.startsWith('https://')) {
			return part.replace(/[),.;]+$/, '')
		}
	}
	return null
}

export function limitExecutionResultValue(
	value: unknown,
	responseLimitBytes: number,
) {
	if (typeof value === 'string') {
		const returnedBytes = getUtf8ByteLength(value)
		if (returnedBytes <= responseLimitBytes) {
			return {
				value,
				displayText: value,
				returnedBytes,
				truncated: false,
			} as const
		}
		const note = `Returned value was ${returnedBytes.toLocaleString()} bytes, exceeding responseLimit ${responseLimitBytes.toLocaleString()} bytes; output was truncated. Project fields before returning.`
		return {
			value: truncateUtf8String(value, responseLimitBytes),
			returnedBytes,
			truncated: true,
			note,
		} as const
	}

	const compactSerialized = JSON.stringify(value) ?? 'undefined'
	const returnedBytes = getUtf8ByteLength(compactSerialized)

	if (returnedBytes <= responseLimitBytes) {
		return {
			value,
			displayText: JSON.stringify(value, null, 2) ?? 'undefined',
			returnedBytes,
			truncated: false,
		} as const
	}

	const note = `Returned value was ${returnedBytes.toLocaleString()} bytes, exceeding responseLimit ${responseLimitBytes.toLocaleString()} bytes; output was truncated. Project fields before returning.`
	const truncatedValue = {
		truncated: true,
		type: describeExecutionValue(value),
	}

	return {
		value: truncatedValue,
		displayText: JSON.stringify(truncatedValue, null, 2) ?? 'undefined',
		returnedBytes,
		truncated: true,
		note,
	} as const
}

export function formatLimitedExecutionOutput(input: {
	value: unknown
	truncated: boolean
	note?: string
	displayText?: string
}) {
	const text =
		input.displayText ?? stringifyExecutionValueForOutput(input.value)
	if (!input.truncated) return text
	return `${text}\n\n--- TRUNCATED ---\n${input.note}`
}

function stringifyExecutionValueForOutput(value: unknown) {
	if (typeof value === 'string') return value
	return JSON.stringify(value, null, 2) ?? 'undefined'
}

function truncateUtf8String(value: string, maxBytes: number) {
	const encoder = new TextEncoder()
	let usedBytes = 0
	let result = ''
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength
		if (usedBytes + characterBytes > maxBytes) break
		result += character
		usedBytes += characterBytes
	}
	return result
}

function getUtf8ByteLength(value: string) {
	return new TextEncoder().encode(value).byteLength
}

function describeExecutionValue(value: unknown) {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	return typeof value
}
