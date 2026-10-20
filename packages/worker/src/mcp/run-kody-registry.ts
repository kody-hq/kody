import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import {
	resolveProvider,
	sanitizeToolName,
	type ExecuteResult,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type Capability,
	type CapabilityOpenApiPrincipal,
} from '#mcp/capabilities/types.ts'
import {
	createExecuteExecutor,
	createNamedExecutionError,
	type ClaimWorkerDay,
} from '#mcp/executor.ts'
import {
	callerDisconnectedSandboxLog,
	callerDisconnectedSandboxMessage,
	createCallerDisconnectedExecutionError,
	isCallerDisconnectAbort,
} from '#worker/caller-disconnect.ts'
import { recordExecuteInterpretableEvent } from '#mcp/execute-interpretable.ts'
import { executeWorkerIdMetadataKey } from '#mcp/execute-invoke.ts'
import {
	classifyExecuteThinGlue,
	type ExecuteThinGlueClass,
} from '#worker/usage/execute-thin-glue.ts'
import {
	resolveDynamicWorkerDaySurface,
	resolveObservedRunSurface,
} from '#worker/usage/dynamic-worker-day-surface.ts'
import { type RawFetchHostSink } from '#mcp/raw-fetch-host-nudge.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import {
	getSecretAuthorityScope,
	resolveSecretAuthorityPackageId,
} from '#mcp/secrets/secret-authority.ts'
import {
	createExecutionSecretRedactor,
	type ExecutionSecretRedactor,
} from '#mcp/secrets/execution-secret-redactor.ts'
import { type BuiltCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	type KodyMcpServerMetadata,
	type KodyResolvedProvider,
} from '#mcp/kody-remote-types.ts'
import {
	createRuntimeHelperExtraProviders,
	createRuntimeHelperKodyToolSets,
	createRuntimeHelperPreludes,
	createRuntimeHelperRuntimePropertySource,
	createUnboundOptionalRuntimeHelperNames,
	type AdditionalKodyTools,
	type CredentialClientToolOptions,
	type EmailToolOptions,
	type PackageEventTools,
	type PackageSecretToolOptions,
	type PackageStorageToolOptions,
	type PackageWorkflowTools,
} from '#mcp/runtime-helper-manifest.ts'
import { newRunCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import {
	type CredentialCallMap,
	type RunCredentialCallMap,
} from '#worker/credentials/credential-call-map.ts'
import {
	loadRunCredentialNeeds,
	validateCredentialCallMap,
} from '#worker/credentials/credential-client.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'
import {
	buildKodyModuleBundle,
	hydrateKodyRuntimeModules,
} from '#worker/package-runtime/module-graph.ts'
import {
	buildComputedPackageImportCallBundle,
	maxComputedPackageImportDepth,
	resolveComputedPackageImportArtifact,
	throwComputedPackageImportFailure,
	type ComputedPackageImportTools,
} from '#worker/package-runtime/computed-package-import.ts'
import { kodyProviderEvaluateBindingName } from '#worker/kody-evaluate-bindings.ts'
import {
	collectLiteralImportSpecifiers,
	getBarePackageNameFromSpecifier,
} from '#worker/package-runtime/import-specifiers.ts'
import {
	createUnboundRuntimeHelperMessage,
	findUnboundRuntimeHelperAccess,
} from '#worker/package-runtime/unbound-runtime-helpers.ts'
import { runWithTransientDurableObjectResetRetry } from '#worker/durable-object-reset-retry.ts'
import { isPreRunUsageDenial } from '#worker/entitlements/errors.ts'
import { evaluationHasHostMediatedSideEffects } from '#mcp/evaluation-side-effects.ts'
import { isTransientJobExecutionError } from '#worker/jobs/execution-safety.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
	type RunSurface,
} from '#worker/run-records/types.ts'
import { shouldRecordExecuteUsageForRun } from '#worker/usage/execute-usage-surface.ts'
import { createDynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { requestLineage } from '#worker/request-context/request-context.ts'
import {
	isDirectBundleDependency,
	type BundleArtifactDependency,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
	usageErrorNameFromUnknown,
} from '#worker/usage/record-usage.ts'
import { createPackageStaticCallMeterTools } from '#worker/usage/package-static-call-usage.ts'
import { recordAgentPackageConversationUses } from '#worker/usage/agent-package-conversation-uses.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	formatMcpServerUnavailableMessage,
	getMcpServerStatus,
} from '#worker/mcp-client/status.ts'
import { mcpServerKodyName } from '#worker/mcp-client/mcp-domain-id.ts'
import { listEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import {
	reportExecutePhaseProgress,
	type McpReportProgress,
} from '#mcp/progress.ts'
import {
	firstCapabilityDispatchWarnTag,
	shouldWarnFirstCapabilityDispatch,
} from './first-capability-dispatch.ts'

/**
 * Wall-clock budget for ad-hoc execute `prepareKodyGraphFiles` + esbuild
 * before sandbox start. Sandbox has its own ~90s host deadline; this bounds
 * the pre-run path so a hung dual heavy-export bundle (historically ~328s
 * MCP client abort with no run row) finishes as a recorded error instead.
 */
export const executeBundleTimeoutMs = 90_000

export function createExecuteBundleTimeoutMessage(timeoutMs: number) {
	const seconds = Math.max(1, Math.round(timeoutMs / 1000))
	return `Execute module bundling exceeded ${seconds}s before sandbox start. Heavy multi-export package graphs (for example multiple zod-based exports from one package) can exceed this budget; prefer remix/data-schema for agent-facing export validation, or import one heavy export per execute module.`
}

export class ExecuteBundleTimeoutError extends Error {
	override name = 'ExecuteBundleTimeoutError'
	constructor(timeoutMs: number) {
		super(createExecuteBundleTimeoutMessage(timeoutMs))
	}
}

async function raceWithExecuteBundleDeadline<T>(
	work: () => Promise<T>,
	input: {
		timeoutMs: number
		signal?: AbortSignal
	},
): Promise<T> {
	const { timeoutMs, signal } = input
	if (signal?.aborted) {
		const reason = signal.reason
		if (reason instanceof Error) throw reason
		throw new DOMException(callerDisconnectedSandboxMessage, 'AbortError')
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return await work()
	}
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			reject(new ExecuteBundleTimeoutError(timeoutMs))
		}, timeoutMs)
		if (!signal) return
		onAbort = () => {
			const reason = signal.reason
			if (reason instanceof Error) {
				reject(reason)
				return
			}
			reject(new DOMException(callerDisconnectedSandboxMessage, 'AbortError'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
	try {
		return await Promise.race([work(), timeoutPromise])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
		if (signal && onAbort) {
			signal.removeEventListener('abort', onAbort)
		}
	}
}

type ExecuteServerTimingEntry = {
	name: string
	durationMs: number
}

type ObservedRunSurfaceOptions = {
	runRecord?: RunRecordContext | null
	runRecordHandle?: RunRecordHandle | null
	runSurface?: RunSurface | null
}

function observedRunSurface(
	options?: ObservedRunSurfaceOptions,
): RunSurface | null {
	return resolveObservedRunSurface({
		surface: options?.runRecord?.surface,
		handleSurface: options?.runRecordHandle?.context.surface,
		runSurface: options?.runSurface,
	})
}

async function scheduleAgentPackageConversationUses(
	env: Env,
	input: Parameters<typeof recordAgentPackageConversationUses>[1],
	waitUntil?: (promise: Promise<unknown>) => void,
) {
	const work = recordAgentPackageConversationUses(env, input)
	if (waitUntil) {
		waitUntil(work)
		return
	}
	await work
}

export type {
	PackageEventDispatchInput,
	PackageEventTools,
	PackageInvokeCheckResult,
	PackageInvokeContract,
	PackageInvokeInput,
	PackageInvokeNormalizedInput,
	PackageInvokeOptions,
	PackageWorkflowTools,
} from '#mcp/runtime-helper-manifest.ts'

export type PackageContextOptions = {
	packageId: string
	kodyId: string
	sourceId?: string | null
} | null

export function createAdHocExecuteSourceFiles(code: string) {
	const sourceFiles: Record<string, string> = { 'entry.ts': code }
	// Most execute modules have no imports. Avoid parsing those entirely so the
	// existing one-file fast path stays unchanged.
	if (!code.includes('import') && !code.includes(' from ')) return sourceFiles
	const packageNames = new Set<string>()
	for (const specifier of collectLiteralImportSpecifiers(code)) {
		const packageName = getBarePackageNameFromSpecifier(specifier)
		if (packageName) packageNames.add(packageName)
	}
	if (packageNames.size === 0) return sourceFiles
	const dependencies = Object.fromEntries(
		[...packageNames]
			.sort((left, right) => left.localeCompare(right))
			.map((packageName) => [packageName, 'latest']),
	)
	sourceFiles['package.json'] = JSON.stringify({ dependencies })
	return sourceFiles
}

/** Once per isolate: sample the first kody.* capability RPC wall time. */
let firstCapabilityDispatchSampled = false

function isPackageSecretAvailabilityError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.startsWith('Secret "') ||
			error.message.startsWith('Package "'))
	)
}

function createPackageSecretTools(input: {
	env: Env
	callerContext: McpCallerContext
	runPackageId: string | null
	grantedPackageIds: ReadonlySet<string>
}): PackageSecretToolOptions {
	const resolveAuthorityPackageId = (requestedPackageId?: string | null) => {
		// Stamp identity only. The executor peels the hidden capability field
		// into host ALS before this tool runs, so a second peel of args is
		// empty. Author-visible `packageId` is ignored so a granted
		// dependency id is not a steal primitive.
		const scope = getSecretAuthorityScope()
		const authorityPackageId = resolveSecretAuthorityPackageId({
			requestedPackageId: requestedPackageId ?? scope?.currentPackageId,
			grantedPackageIds: input.grantedPackageIds,
			runPackageId: input.runPackageId,
		})
		if (
			!authorityPackageId ||
			!input.grantedPackageIds.has(authorityPackageId)
		) {
			throw new Error(
				'Package secret access requires a matching server-side package runtime context.',
			)
		}
		return authorityPackageId
	}
	const resolveMount = (
		alias: string,
		requestedPackageId?: string | null,
		access?: 'presence' | 'value',
	) =>
		resolveCredential({
			env: input.env,
			orgId: ownerIdFromCaller(input.callerContext),
			actor: input.callerContext.request,
			packageStamp: attestedPackageStamp(
				resolveAuthorityPackageId(requestedPackageId),
			),
			baseUrl: input.callerContext.baseUrl,
			credential: {
				use: 'package-secret-mount',
				alias,
				callerContext: input.callerContext,
				...(access ? { access } : {}),
			},
		})
	return {
		runPackageId: input.runPackageId,
		get: async (alias: string, requestedPackageId?: string | null) =>
			(await resolveMount(alias, requestedPackageId)).ref,
		has: async (alias: string, requestedPackageId?: string | null) => {
			try {
				await resolveMount(alias, requestedPackageId, 'presence')
				return true
			} catch (error) {
				if (isPackageSecretAvailabilityError(error)) {
					return false
				}
				throw error
			}
		},
	}
}

export function createWorkflowTools(input: {
	env: Env
	callerContext: McpCallerContext
	packageContext: PackageContextOptions
}): PackageWorkflowTools {
	const packageContext = input.packageContext
	return {
		create: async (body) => {
			const userId = input.callerContext.user
				? personalOrgId(input.callerContext.user.userId)
				: undefined
			const request = input.callerContext.request
			if (!userId || !request) {
				throw new Error('workflows.create requires an authenticated user.')
			}
			return await createDynamicCallableWorkflow({
				env: input.env,
				userId,
				userEmail: input.callerContext.user?.email,
				packageContext,
				body,
				lineage: requestLineage(request),
			})
		},
	}
}

export async function buildKodyFns(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		packageStorageTools?: PackageStorageToolOptions
		packageSecretTools?: PackageSecretToolOptions
		credentialClientTools?: CredentialClientToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
	},
) {
	return (await buildKodyToolContext(env, callerContext, options)).tools
}

export async function buildKodyToolContext(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		packageStorageTools?: PackageStorageToolOptions
		packageSecretTools?: PackageSecretToolOptions
		credentialClientTools?: CredentialClientToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
		reportProgress?: McpReportProgress
		waitUntil?: (promise: Promise<unknown>) => void
		openApiPrincipal?: CapabilityOpenApiPrincipal
	},
): Promise<{
	tools: AdditionalKodyTools
	mcpServers: Array<KodyMcpServerMetadata>
}> {
	const capabilityMap = options?.skipCapabilityRegistry
		? {}
		: options?.capabilityRegistry
			? options.capabilityRegistry.capabilityMap
			: (
					await getCapabilityRegistryForContext({
						env,
						callerContext,
					})
				).capabilityMap
	// Closed-world / registry-skipped runs have no kody.mcp capabilities.
	// Assembling server metadata still lists enabled servers and, on a hub
	// cache miss, drains connection events into package subscriptions.
	const mcpServers = options?.skipCapabilityRegistry
		? []
		: await buildKodyMcpServerMetadata({
				env,
				callerContext,
				capabilityMap,
			})
	const additionalTools = options?.additionalTools ?? {}
	assertNoCapabilityCollisions(capabilityMap, additionalTools)
	const capabilityKodyTools = Object.fromEntries(
		Object.entries(capabilityMap).map(([capabilityName, capability]) => [
			capabilityName,
			async (args: unknown) => {
				// First capability RPC in a cold isolate often pays for lazy module
				// graphs behind handlers; log once so regressions stay visible.
				const shouldSampleFirstDispatch = !firstCapabilityDispatchSampled
				const dispatchStartedAtMs = shouldSampleFirstDispatch ? Date.now() : 0
				if (shouldSampleFirstDispatch) {
					firstCapabilityDispatchSampled = true
				}
				try {
					await assertCallerCanAccessCapability(callerContext, capability, {
						env,
					})
					const toolArgs = (args ?? {}) as Record<string, unknown>
					trackPersistedSecretInputValues(
						capabilityName,
						toolArgs,
						options?.trackSecretInputValue,
					)
					return await capability.handler(toolArgs, {
						env,
						callerContext,
						...(options?.reportProgress
							? { reportProgress: options.reportProgress }
							: {}),
						...(options?.waitUntil ? { waitUntil: options.waitUntil } : {}),
						...(options?.openApiPrincipal
							? { openApiPrincipal: options.openApiPrincipal }
							: {}),
					})
				} finally {
					if (shouldSampleFirstDispatch) {
						const durationMs = Date.now() - dispatchStartedAtMs
						if (shouldWarnFirstCapabilityDispatch(durationMs)) {
							console.warn(firstCapabilityDispatchWarnTag, {
								capabilityName,
								durationMs,
							})
						}
					}
				}
			},
		]),
	) as AdditionalKodyTools
	const runtimeHelperKodyToolSets = await createRuntimeHelperKodyToolSets({
		env,
		callerContext,
		capabilityMap,
		packageStorageTools: options?.packageStorageTools,
		packageSecretTools: options?.packageSecretTools,
		credentialClientTools: options?.credentialClientTools,
		emailTools: options?.emailTools,
		workflowTools: options?.workflowTools,
	})
	for (const { tools } of runtimeHelperKodyToolSets) {
		assertNoCapabilityCollisions(capabilityMap, tools)
	}
	const runtimeHelperKodyTools = Object.assign(
		{},
		...runtimeHelperKodyToolSets.map(({ tools }) => tools),
	) as AdditionalKodyTools
	return {
		tools: {
			...capabilityKodyTools,
			...runtimeHelperKodyTools,
			...additionalTools,
		},
		mcpServers,
	}
}

function assertNoCapabilityCollisions(
	capabilityMap: Record<string, unknown>,
	tools: AdditionalKodyTools,
) {
	for (const name of Object.keys(tools)) {
		if (capabilityMap[name]) {
			throw new Error(`Kody helper "${name}" collides with a capability.`)
		}
	}
}

async function buildKodyMcpServerMetadata(input: {
	env: Env
	callerContext: McpCallerContext
	capabilityMap: Record<string, Capability>
}): Promise<Array<KodyMcpServerMetadata>> {
	const userId = ownerIdFromCaller(input.callerContext) || null
	const servers = new Map<string, KodyMcpServerMetadata>()

	if (userId) {
		// Per-org 30s cache: runtime metadata assembly runs on every execute /
		// package invocation, so this must not cost a D1 read per call.
		// List every enabled server (including package-locked). Call-time
		// assertCanUseMcpServer + stamp ALS deny execute / unapproved packages;
		// filtering here would make package-via-execute throw Unknown MCP server.
		const refs = await listEnabledMcpServerRefsCached({
			env: input.env,
			userId,
		}).catch((error: unknown) => {
			// Degrade to "no MCP servers" but leave a trail: silently losing
			// kody.mcp[...] accessors is very hard to debug otherwise.
			console.warn('mcp-server-refs-load-failed', error)
			return []
		})
		for (const ref of refs) {
			const name = mcpServerKodyName(ref)
			const status = await getMcpServerStatus({
				env: input.env,
				userId,
				ref,
			})
			servers.set(name, {
				name,
				serverId: ref.serverId,
				status: {
					state: status.state,
					connected: status.ready,
					toolCount: status.toolCount,
					message: status.message,
					unavailableMessage: formatMcpServerUnavailableMessage(status),
				},
				capabilities: [],
			})
		}
	}

	for (const capability of Object.values(input.capabilityMap)) {
		if (capability.source !== 'mcp-server') continue
		const mcpServer = capability.mcpServer
		if (!mcpServer) continue
		const existing =
			servers.get(mcpServer.kodyName) ??
			({
				name: mcpServer.kodyName,
				serverId: mcpServer.serverId,
				status: {
					state: 'ready',
					connected: true,
					toolCount: 0,
					message: `The MCP server "${mcpServer.serverName}" is connected.`,
					unavailableMessage: `The MCP server "${mcpServer.serverName}" is connected.`,
				},
				capabilities: [],
			} satisfies KodyMcpServerMetadata)
		existing.capabilities.push({
			name: mcpServer.toolName,
			dispatchName: sanitizeToolName(capability.name),
		})
		existing.capabilities.sort((a, b) => a.name.localeCompare(b.name, 'en'))
		existing.status.toolCount = Math.max(
			existing.status.toolCount,
			existing.capabilities.length,
		)
		servers.set(mcpServer.kodyName, existing)
	}

	return [...servers.values()].sort((a, b) =>
		a.name.localeCompare(b.name, 'en'),
	)
}

export async function buildKodyProvider(
	env: Env,
	callerContext: McpCallerContext,
	options?: {
		trackSecretInputValue?: (value: string) => void
		additionalTools?: AdditionalKodyTools
		packageStorageTools?: PackageStorageToolOptions
		packageSecretTools?: PackageSecretToolOptions
		credentialClientTools?: CredentialClientToolOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		skipCapabilityRegistry?: boolean
		capabilityRegistry?: BuiltCapabilityRegistry
		reportProgress?: McpReportProgress
		waitUntil?: (promise: Promise<unknown>) => void
	},
): Promise<ResolvedProvider> {
	const { tools, mcpServers } = await buildKodyToolContext(
		env,
		callerContext,
		options,
	)
	const provider: ToolProvider = {
		name: 'kody',
		tools: Object.fromEntries(
			Object.entries(tools).map(([name, execute]) => [
				name,
				{
					execute,
				},
			]),
		),
	}
	return Object.assign(resolveProvider(provider), {
		kodyMcpServers: mcpServers,
	}) satisfies KodyResolvedProvider
}

export async function runModuleWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	code: string,
	params?: Record<string, unknown>,
	options?: {
		executorExports?: typeof workerExports
		additionalTools?: AdditionalKodyTools
		packageContext?: PackageContextOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		executorTimeoutMs?: number | null
		signal?: AbortSignal
		packageEventTools?: PackageEventTools
		capabilityRegistry?: BuiltCapabilityRegistry
		rawFetchHostSink?: RawFetchHostSink
		/** Capped unique-worker-day claim for the top-level hosted execute worker. */
		claimWorkerDay?: ClaimWorkerDay
		/**
		 * When set (MCP public `execute` tool), static/dynamic `kody:@…`
		 * package deps are credited toward agent-facing package popularity.
		 */
		conversationId?: string | null
		runRecord?: RunRecordContext | null
		runRecordHandle?: RunRecordHandle | null
		/**
		 * Observed run surface when this call does not own a run record
		 * (keyed package invocations, inline workflows). Used for UWD and
		 * execute-usage attribution; does not begin or finish a record.
		 */
		runSurface?: RunSurface | null
		/**
		 * When set, post-terminal run-record side effects are scheduled on this
		 * callback (typically `ctx.waitUntil`). The terminal Durable Object write
		 * itself is always awaited so a completed invocation is not stranded as
		 * `running`.
		 */
		waitUntil?: (promise: Promise<unknown>) => void
		/**
		 * Optional MCP progress reporter (from `_meta.progressToken`). Emits
		 * human-friendly phase messages aligned with `serverTiming` names.
		 */
		reportProgress?: McpReportProgress
		credentialCallMap?: RunCredentialCallMap | null
	},
): Promise<
	ExecuteResult & {
		runId?: string
		serverTiming?: Array<{ name: string; durationMs: number }>
	}
> {
	const actorUserId = callerContext.user?.userId ?? ''
	const packageOwnerUserId = ownerIdFromCaller(callerContext)
	const serverTiming: Array<{ name: string; durationMs: number }> = []
	const reportProgress = options?.reportProgress
	const isAdHocExecute = shouldRecordExecuteUsageForRun({
		surface: observedRunSurface(options),
		hasPackageContext: Boolean(options?.packageContext),
	})
	const executeShape = isAdHocExecute ? classifyExecuteThinGlue(code) : null
	if (isAdHocExecute && !options?.packageContext) {
		recordExecuteInterpretableEvent(env, { source: code })
	}
	// Begin (or reuse a keyed claim) before bundling so a hung/timeout
	// prepare+esbuild path still leaves a visible run row. Previously
	// begin lived only inside runBundledModuleWithRegistry — after bundle —
	// so dual heavy-export hangs produced MCP client aborts with no Activity.
	const runRecordHandle =
		options?.runRecordHandle ??
		beginRunRecord({
			env,
			userId: ownerIdFromCaller(callerContext) || null,
			context: options?.runRecord ?? null,
			waitUntil: options?.waitUntil,
		})
	let enteredBundledRun = false
	try {
		await reportExecutePhaseProgress(reportProgress, 'bundle')
		const bundleStartedAtMs = Date.now()
		const bundled = await raceWithExecuteBundleDeadline(
			async () =>
				await buildKodyModuleBundle({
					env,
					baseUrl: callerContext.baseUrl,
					userId: packageOwnerUserId,
					sourceFiles: createAdHocExecuteSourceFiles(code),
					entryPoint: 'entry.ts',
					reuseCachedBundle: true,
					bundleContext: 'ad-hoc-execute',
				}),
			{
				timeoutMs: executeBundleTimeoutMs,
				signal: options?.signal,
			},
		)
		serverTiming.push({
			name: 'bundle',
			durationMs: Date.now() - bundleStartedAtMs,
		})
		const conversationId = options?.conversationId?.trim()
		if (conversationId && actorUserId) {
			const packageIds = bundled.dependencies
				.filter(isDirectBundleDependency)
				.map((dependency) => dependency.packageId)
				.filter((packageId): packageId is string => Boolean(packageId))
			if (packageIds.length > 0) {
				await scheduleAgentPackageConversationUses(
					env,
					{
						userId: actorUserId,
						packageIds,
						conversationId,
					},
					options?.waitUntil,
				)
			}
		}
		const runStartedAtMs = Date.now()
		enteredBundledRun = true
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			{
				mainModule: bundled.mainModule,
				modules: bundled.modules,
				dependencies: bundled.dependencies,
			},
			params,
			{
				...options,
				executeShape,
				runRecordHandle,
				packageContext: options?.packageContext ?? null,
				workflowTools:
					options?.workflowTools ??
					createWorkflowTools({
						env,
						callerContext,
						packageContext: options?.packageContext ?? null,
					}),
				packageEventTools: options?.packageEventTools,
				conversationId: options?.conversationId ?? null,
				reportProgress,
				waitUntil: options?.waitUntil,
			},
		)
		// Sub-phases (hydrate → provider-assembly → sandbox) report inside the
		// bundled run so progress stays monotonic. `run` is only the enclosing
		// serverTiming wall-clock span, not a client progress step.
		serverTiming.push(...(result.serverTiming ?? []), {
			name: 'run',
			durationMs: Date.now() - runStartedAtMs,
		})
		return { ...result, serverTiming }
	} catch (error) {
		if (runRecordHandle && !enteredBundledRun) {
			const disconnect =
				options?.signal &&
				isCallerDisconnectAbort(options.signal) &&
				!(error instanceof ExecuteBundleTimeoutError)
			const recordedError = disconnect
				? createCallerDisconnectedExecutionError()
				: error
			await finishRunRecord({
				env,
				handle: runRecordHandle,
				status: 'error',
				error: recordedError,
			})
			return {
				result: undefined,
				error: getErrorMessage(recordedError),
				logs: [],
				...(runRecordHandle.persistence === 'eager'
					? { runId: runRecordHandle.id }
					: {}),
				serverTiming,
			}
		}
		throw error
	}
}

/**
 * Provenance grant set for one bundled run, from bundler/host controlled
 * metadata only: the run's own package context, the saved packages recorded
 * in the bundle's static dependency metadata, and the published artifacts
 * installed for literal dynamic package imports during hydration.
 * `packageStorage()` and stamp-aligned secret authority both use this set.
 * Sandbox-supplied strings never extend it, which is what keeps a malicious
 * module from claiming another installed package's bucket or secret grants.
 */
export function collectPackageStorageGrantIds(input: {
	packageContext: PackageContextOptions
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencyPackageIds: Array<string>
}): ReadonlySet<string> {
	const grantedPackageIds = new Set<string>()
	if (input.packageContext?.packageId) {
		grantedPackageIds.add(input.packageContext.packageId)
	}
	for (const dependency of input.dependencies) {
		if (dependency.packageId) {
			grantedPackageIds.add(dependency.packageId)
		}
	}
	for (const packageId of input.dynamicDependencyPackageIds) {
		grantedPackageIds.add(packageId)
	}
	return grantedPackageIds
}

/**
 * The packages whose needs closures pin a run's credential needs, in
 * precedence order. A run's own package's static imports are pinned by its
 * closure, so they are not entries; ad hoc code has no closure, so its direct
 * imports are. A computed import's callee pins its own imports. Literal
 * dynamic imports are never in a closure, so each is its own entry.
 */
export function credentialNeedsEntryPackageIds(input: {
	packageContext: PackageContextOptions
	computedImportCalleePackageId: string | null
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencyPackageIds: Array<string>
}): Array<string> {
	const contextPackageId = input.packageContext?.packageId ?? null
	const staticEntries = input.computedImportCalleePackageId
		? [input.computedImportCalleePackageId]
		: contextPackageId
			? []
			: input.dependencies
					.filter(isDirectBundleDependency)
					.map((dependency) => dependency.packageId)
					.filter((packageId): packageId is string => Boolean(packageId))
	return [
		...new Set([
			...(contextPackageId ? [contextPackageId] : []),
			...staticEntries,
			...input.dynamicDependencyPackageIds,
		]),
	]
}

/**
 * Host tools for computed `import(specifier)` of caller-owned `kody:@`
 * names. Nested evaluate uses library-load semantics: caller's
 * `packageContext`, callee stamp grants via the importable-module artifact.
 */
export function createComputedPackageImportTools(input: {
	env: Env
	baseUrl: string
	callerContext: McpCallerContext
	packageContext: PackageContextOptions
	packageEventTools?: PackageEventTools
	emailTools?: EmailToolOptions
	workflowTools?: PackageWorkflowTools
	additionalTools?: AdditionalKodyTools
	skipCapabilityRegistry?: boolean
	capabilityRegistry?: BuiltCapabilityRegistry
	waitUntil?: (promise: Promise<unknown>) => void
	signal?: AbortSignal
	/** Preserve outer execute timeout policy on nested library loads. */
	executorTimeoutMs?: number | null
	computedImportDepth?: number
	/**
	 * Agent conversation id from the outer MCP execute. Records the resolved
	 * callee package id for popularity; nested evaluate does not re-attribute
	 * the callee's own transitive deps.
	 */
	conversationId?: string | null
	/**
	 * Propagate closed-world retriever restrictions into nested library loads
	 * when a restricted run supplies these tools explicitly.
	 */
	closedWorldRetrieverRuntime?: boolean
	/** The caller's credential picks, which nested library loads keep. */
	credentialCallMap?: CredentialCallMap | null
}): ComputedPackageImportTools {
	const computedImportDepth = input.computedImportDepth ?? 0
	return {
		async callDefault(rawInput) {
			const specifier =
				typeof rawInput?.specifier === 'string' ? rawInput.specifier.trim() : ''
			if (!specifier) {
				throw new Error(
					'Computed kody:@ import requires a non-empty specifier string.',
				)
			}
			const actorUserId = input.callerContext.user?.userId
			const packageOwnerUserId = ownerIdFromCaller(input.callerContext)
			if (!packageOwnerUserId) {
				throw new Error(
					'Dynamic kody:@ package import requires an authenticated runtime. Use a static import (import fn from "kody:@scope/package/export") when the package name is known at write time.',
				)
			}
			if (computedImportDepth >= maxComputedPackageImportDepth) {
				throw new Error(
					`Computed kody:@ import exceeded the maximum nested depth (${maxComputedPackageImportDepth}).`,
				)
			}
			const artifact = await resolveComputedPackageImportArtifact({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: packageOwnerUserId,
				specifier,
			})
			const conversationId = input.conversationId?.trim()
			const calleePackageId = artifact.packageContext?.packageId?.trim()
			if (conversationId && actorUserId && calleePackageId) {
				await scheduleAgentPackageConversationUses(
					input.env,
					{
						userId: actorUserId,
						packageIds: [calleePackageId],
						conversationId,
					},
					input.waitUntil,
				)
			}
			const callBundle = buildComputedPackageImportCallBundle({
				artifact,
				specifier,
			})
			const nestedTools = createComputedPackageImportTools({
				...input,
				computedImportDepth: computedImportDepth + 1,
			})
			const result = await runBundledModuleWithRegistry(
				input.env,
				input.callerContext,
				{
					mainModule: callBundle.mainModule,
					modules: callBundle.modules,
					dependencies: callBundle.dependencies,
				},
				rawInput.params,
				{
					packageContext: input.packageContext,
					packageEventTools: input.packageEventTools,
					emailTools: input.emailTools,
					workflowTools: input.workflowTools,
					additionalTools: input.additionalTools,
					skipCapabilityRegistry: input.skipCapabilityRegistry,
					capabilityRegistry: input.capabilityRegistry,
					waitUntil: input.waitUntil,
					executorTimeoutMs: input.executorTimeoutMs,
					signal: input.signal,
					computedImportDepth: computedImportDepth + 1,
					computedPackageImportTools: nestedTools,
					closedWorldRetrieverRuntime: input.closedWorldRetrieverRuntime,
					credentialCallMap: input.credentialCallMap
						? { map: input.credentialCallMap, strict: false, checked: true }
						: null,
					computedImportCalleePackageId: calleePackageId ?? null,
					// Library load is not enter-as-package: do not attribute a
					// package_export usage event to the caller's package id.
					skipPackageExportUsage: true,
					// Nested evaluate is not a second MCP execute call.
					skipExecuteUsage: true,
				},
			)
			if (result.error) {
				throwComputedPackageImportFailure({
					specifier,
					error: result.error,
				})
			}
			return result.result
		},
	}
}

export async function runBundledModuleWithRegistry(
	env: Env,
	callerContext: McpCallerContext,
	bundle: {
		mainModule: string
		modules: WorkerLoaderModules
		/**
		 * Bundle dependency metadata recorded at build time (static
		 * `kody:@scope/package` imports). Used as provenance for
		 * `packageStorage()` grants; omit it and only the run's own package
		 * context is granted.
		 */
		dependencies?: Array<BundleArtifactDependency>
	},
	params?: Record<string, unknown>,
	options?: {
		executorExports?: typeof workerExports
		additionalTools?: AdditionalKodyTools
		packageContext?: PackageContextOptions
		emailTools?: EmailToolOptions
		workflowTools?: PackageWorkflowTools
		packageEventTools?: PackageEventTools
		/**
		 * Host bridge for computed `import(specifier)` of caller-owned
		 * `kody:@` names. When omitted on an authenticated run (outside
		 * closed-world retriever), a default bridge is created.
		 */
		computedPackageImportTools?: ComputedPackageImportTools
		/** Nested depth for computed import library loads. */
		computedImportDepth?: number
		/**
		 * Skip `package_export` usage attribution for this evaluate. Used by
		 * computed-import library loads so the caller's package id is not
		 * billed as if its own export ran.
		 */
		skipPackageExportUsage?: boolean
		/**
		 * Skip `execute` usage metering for this evaluate. Used by computed
		 * import library loads so nested default calls do not inflate the
		 * outer MCP execute call metric.
		 */
		skipExecuteUsage?: boolean
		skipCapabilityRegistry?: boolean
		/**
		 * Retriever enrichment profile: no capability map, no workflows,
		 * no package invoke/events, read-only packageStorage, no outbound
		 * fetch. Search annotations depend on this being a runtime constraint.
		 */
		closedWorldRetrieverRuntime?: boolean
		executorTimeoutMs?: number | null
		signal?: AbortSignal
		runRecord?: RunRecordContext | null
		/**
		 * Pre-claimed handle from {@link claimRunRecord} (keyed execute). When
		 * set, begin is skipped so the running row already owns the key.
		 */
		runRecordHandle?: RunRecordHandle | null
		/**
		 * Observed run surface when this call does not own a run record
		 * (keyed package invocations, inline workflows). Used for UWD and
		 * execute-usage attribution; does not begin or finish a record.
		 */
		runSurface?: RunSurface | null
		capabilityRegistry?: BuiltCapabilityRegistry
		rawFetchHostSink?: RawFetchHostSink
		conversationId?: string | null
		/**
		 * When set, post-terminal run-record side effects are scheduled on this
		 * callback (typically `ctx.waitUntil`). The terminal Durable Object write
		 * itself is always awaited.
		 */
		waitUntil?: (promise: Promise<unknown>) => void
		reportProgress?: McpReportProgress
		/**
		 * Host-side thin/glue class for ad-hoc execute. Set by
		 * `runModuleWithRegistry` from the caller-authored source string.
		 */
		executeShape?: ExecuteThinGlueClass | null
		claimWorkerDay?: ClaimWorkerDay
		credentialCallMap?: RunCredentialCallMap | null
		/** The package a computed-import library load runs. */
		computedImportCalleePackageId?: string | null
	},
): Promise<
	ExecuteResult & {
		runId?: string
		serverTiming?: Array<ExecuteServerTimingEntry>
	}
> {
	const runServerTiming: Array<ExecuteServerTimingEntry> = []
	const secretRedactor = createExecutionSecretRedactor()
	const reportProgress = options?.reportProgress
	const normalizedStorageContext = normalizeStorageContext(
		callerContext.storageContext ?? null,
	)
	const runRecordContext = options?.runRecord
		? {
				...options.runRecord,
				storageId:
					options.runRecord.storageId ??
					normalizedStorageContext?.storageId ??
					null,
			}
		: null
	const waitUntil = options?.waitUntil
	const runRecordHandle =
		options?.runRecordHandle ??
		beginRunRecord({
			env,
			userId: ownerIdFromCaller(callerContext) || null,
			context: runRecordContext,
			waitUntil,
		})
	let runRecordFinished = false
	const callerOwnsScheduledJobRun =
		options?.runRecordHandle != null &&
		(options.runRecord?.surface === 'job' ||
			options.runRecordHandle.context.surface === 'job')
	let exposeRunId = runRecordHandle?.persistence === 'eager'
	let capturedLogs: Array<string> | undefined
	// The metering span covers the whole bundled run (module hydration,
	// provider assembly, and sandbox execution) so pre-executor failures are
	// still counted as failed package runs.
	const usageStartedAtMs = Date.now()
	let usageRecorded = false
	async function recordPackageExportUsage(
		outcome: 'success' | 'error',
		error?: unknown,
	) {
		if (usageRecorded) return
		usageRecorded = true
		if (options?.skipPackageExportUsage) return
		const userId = ownerIdFromCaller(callerContext)
		if (!options?.packageContext || !userId) return
		const errorName =
			outcome === 'error' ? usageErrorNameFromUnknown(error) : ''
		await recordUsage(env, {
			userId,
			eventType: 'package_export',
			entityId: options.packageContext.packageId,
			durationMs: Date.now() - usageStartedAtMs,
			outcome,
			...(errorName ? { errorName } : {}),
			...usageAttributionFieldsFromRequest(callerContext.request),
		})
	}
	async function finishObservedRun(input: {
		status: 'success' | 'error'
		logs?: Array<string>
		error?: unknown
		result?: unknown
	}) {
		if (input.status === 'error') {
			exposeRunId = Boolean(runRecordHandle)
		}
		await finishRunRecord({
			env,
			handle: runRecordHandle,
			status: input.status,
			logs: input.logs,
			error: input.error,
			result: input.result,
			waitUntil,
		})
		runRecordFinished = true
	}
	/**
	 * A caller that pre-claimed the run record finishes or releases it:
	 * the job scheduler retries transient failures, and keyed execute
	 * releases its key when the capped worker-day claim denies the load.
	 */
	function leavesCallerRunRecordOpen(error: unknown) {
		if (runRecordFinished || options?.runRecordHandle == null) return false
		if (callerOwnsScheduledJobRun && isTransientJobExecutionError(error)) {
			return true
		}
		return options.claimWorkerDay != null && isPreRunUsageDenial(error)
	}
	function resolveThrownRunError(error: unknown): {
		error: unknown
		logs: Array<string> | undefined
	} {
		if (
			options?.signal &&
			isCallerDisconnectAbort(options.signal) &&
			error instanceof Error &&
			error.name === 'AbortError'
		) {
			return {
				error: createCallerDisconnectedExecutionError(),
				logs: capturedLogs ?? [callerDisconnectedSandboxLog],
			}
		}
		return { error, logs: capturedLogs }
	}
	function withRunId<T extends ExecuteResult>(
		result: T,
	): T & { runId?: string; serverTiming?: Array<ExecuteServerTimingEntry> } {
		const timed =
			runServerTiming.length > 0
				? { ...result, serverTiming: [...runServerTiming] }
				: result
		if (!exposeRunId || !runRecordHandle) return timed
		return { ...timed, runId: runRecordHandle.id }
	}
	// Host-observed run outcome for static-call reclassification. Default to
	// failed so an early throw before execute still treats buffered throws as
	// real errors. Set false only when execute returns without `error`.
	let staticCallRunFailed = true
	let staticCallMeterTools:
		| ReturnType<typeof createPackageStaticCallMeterTools>
		| undefined
	try {
		// Hydration can install additional published-package sources (literal
		// dynamic `import("kody:@...")` targets); keep a reference so error
		// rewriting below scans the same module graph the sandbox executed.
		await reportExecutePhaseProgress(reportProgress, 'hydrate')
		const hydrateStartedAtMs = Date.now()
		const { modules: hydratedModules, dynamicDependencyPackageIds } =
			await hydrateKodyRuntimeModules({
				env,
				baseUrl: callerContext.baseUrl,
				userId: ownerIdFromCaller(callerContext),
				modules: bundle.modules,
			})
		runServerTiming.push({
			name: 'hydrate',
			durationMs: Date.now() - hydrateStartedAtMs,
		})
		const agentConversationId = options?.conversationId?.trim()
		const agentUserId = callerContext.user?.userId
		if (
			agentConversationId &&
			agentUserId &&
			dynamicDependencyPackageIds.length > 0
		) {
			await scheduleAgentPackageConversationUses(
				env,
				{
					userId: agentUserId,
					packageIds: dynamicDependencyPackageIds,
					conversationId: agentConversationId,
				},
				waitUntil,
			)
		}
		await reportExecutePhaseProgress(reportProgress, 'provider-assembly')
		const providerAssemblyStartedAtMs = Date.now()
		const grantedPackageStorageIds = collectPackageStorageGrantIds({
			packageContext: options?.packageContext ?? null,
			dependencies: bundle.dependencies ?? [],
			dynamicDependencyPackageIds,
		})
		// Static package export calls report through a sandbox bridge with a
		// bundler-stamped callee package id; accept direct *and* transitive
		// static dependency ids recorded at build time so a re-export chain
		// that meters once at the innermost layer is not dropped host-side
		// (mismatches are still dropped). This is still tighter than the
		// packageStorage grant set, which additionally includes the run's own
		// package id and dynamic-import dependencies. Throws are buffered
		// until finalize with the host run outcome so caught throws become
		// `caught` (alert math counts `error` only).
		staticCallMeterTools = createPackageStaticCallMeterTools({
			env,
			userId: ownerIdFromCaller(callerContext) || null,
			request: callerContext.request,
			grantedPackageIds: new Set(
				(bundle.dependencies ?? [])
					.map((dependency) => dependency.packageId)
					.filter((packageId): packageId is string => Boolean(packageId)),
			),
		})
		const closedWorldRetrieverRuntime =
			options?.closedWorldRetrieverRuntime === true
		const callMap = options?.credentialCallMap ?? null
		const credentialEntryPackageIds = credentialNeedsEntryPackageIds({
			packageContext: options?.packageContext ?? null,
			computedImportCalleePackageId:
				options?.computedImportCalleePackageId ?? null,
			dependencies: bundle.dependencies ?? [],
			dynamicDependencyPackageIds,
		})
		if (callMap && !callMap.checked) {
			const { warnings } = await validateCredentialCallMap({
				env,
				request: callerContext.request ?? null,
				map: callMap.map,
				packageIds: credentialEntryPackageIds,
				strict: callMap.strict,
				baseUrl: callerContext.baseUrl,
			})
			if (warnings.length > 0) callMap.onWarnings?.(warnings)
		}
		const credentialClientBinding = newRunCredentialClientBinding()
		let runNeeds: Promise<ReadonlyMap<string, CredentialNeed>> | null = null
		const credentialClientTools: CredentialClientToolOptions | undefined =
			callerContext.user?.userId && !closedWorldRetrieverRuntime
				? {
						binding: credentialClientBinding,
						// A claimed id selects which package's needs apply; only a
						// package in this run's provenance may be claimed.
						resolvePackageId: async (requested) =>
							typeof requested === 'string' &&
							grantedPackageStorageIds.has(requested)
								? requested
								: (options?.packageContext?.packageId ?? null),
						callMap: callMap?.map ?? null,
						runNeeds: () => {
							const request = callerContext.request
							if (!request) return Promise.resolve(new Map())
							runNeeds ??= loadRunCredentialNeeds({
								env,
								orgId: request.org.id,
								packageIds: credentialEntryPackageIds,
							})
							return runNeeds
						},
						waitUntil: options?.waitUntil,
					}
				: undefined
		const executor = createExecuteExecutor({
			env,
			exports: options?.executorExports ?? workerExports,
			timeoutMs: options?.executorTimeoutMs,
			signal: options?.signal,
			gatewayProps: {
				baseUrl: callerContext.baseUrl,
				userId: ownerIdFromCaller(callerContext) || null,
				email: callerContext.user?.email ?? null,
				request: callerContext.request,
				storageContext: normalizedStorageContext,
				grantedSecretAuthorityPackageIds: [...grantedPackageStorageIds],
				credentialClientBinding: credentialClientTools
					? credentialClientBinding
					: null,
			},
			modules: hydratedModules,
			// Package-context runs are saved-package code; do not count their fetch hosts.
			rawFetchHostSink: options?.packageContext
				? undefined
				: options?.rawFetchHostSink,
			recordExecuteUsage:
				options?.skipExecuteUsage === true
					? false
					: shouldRecordExecuteUsageForRun({
							surface: observedRunSurface(options),
							hasPackageContext: Boolean(options?.packageContext),
						}),
			surface: resolveDynamicWorkerDaySurface({
				surface: options?.runRecord?.surface,
				handleSurface: options?.runRecordHandle?.context.surface,
				runSurface: options?.runSurface,
				hasPackageContext: Boolean(options?.packageContext),
			}),
			packageId: options?.packageContext?.packageId ?? null,
			executeShape: options?.executeShape,
			allowOutboundFetch: !closedWorldRetrieverRuntime,
			onWorkerId: runRecordHandle
				? (workerId) => {
						runRecordHandle.context = {
							...runRecordHandle.context,
							metadata: {
								...runRecordHandle.context.metadata,
								[executeWorkerIdMetadataKey]: workerId,
							},
						}
					}
				: undefined,
			claimWorkerDay: options?.claimWorkerDay,
			waitUntil: options?.waitUntil,
		})
		const workflowTools = closedWorldRetrieverRuntime
			? undefined
			: (options?.workflowTools ??
				createWorkflowTools({
					env,
					callerContext,
					packageContext: options?.packageContext ?? null,
				}))
		const computedPackageImportTools =
			options?.computedPackageImportTools ??
			(callerContext.user?.userId && !closedWorldRetrieverRuntime
				? createComputedPackageImportTools({
						env,
						baseUrl: callerContext.baseUrl,
						callerContext,
						packageContext: options?.packageContext ?? null,
						packageEventTools: options?.packageEventTools,
						emailTools: options?.emailTools,
						workflowTools,
						additionalTools: options?.additionalTools,
						skipCapabilityRegistry: options?.skipCapabilityRegistry,
						capabilityRegistry: options?.capabilityRegistry,
						waitUntil: options?.waitUntil,
						signal: options?.signal,
						executorTimeoutMs: options?.executorTimeoutMs,
						computedImportDepth: options?.computedImportDepth ?? 0,
						conversationId: options?.conversationId ?? null,
						closedWorldRetrieverRuntime,
						credentialCallMap: callMap?.map ?? null,
					})
				: undefined)
		// Register the package_storage_* tools whenever the run has a user, even
		// with an empty grant set: an unauthorized packageStorage() call then
		// fails with the structured provenance message instead of a bare
		// missing-capability TypeError.
		const packageStorageTools = callerContext.user?.userId
			? {
					grantedPackageIds: grantedPackageStorageIds,
					writable: !closedWorldRetrieverRuntime,
				}
			: undefined
		const packageSecretTools = callerContext.user?.userId
			? createPackageSecretTools({
					env,
					callerContext,
					runPackageId: options?.packageContext?.packageId ?? null,
					grantedPackageIds: grantedPackageStorageIds,
				})
			: undefined
		const provider = await buildKodyProvider(env, callerContext, {
			trackSecretInputValue: (value) => {
				secretRedactor.track(value)
			},
			additionalTools: options?.additionalTools,
			packageStorageTools,
			packageSecretTools,
			credentialClientTools,
			emailTools: closedWorldRetrieverRuntime ? undefined : options?.emailTools,
			workflowTools,
			skipCapabilityRegistry:
				closedWorldRetrieverRuntime || options?.skipCapabilityRegistry,
			capabilityRegistry: closedWorldRetrieverRuntime
				? undefined
				: options?.capabilityRegistry,
			reportProgress,
			waitUntil: options?.waitUntil,
		})
		runServerTiming.push({
			name: 'provider-assembly',
			durationMs: Date.now() - providerAssemblyStartedAtMs,
		})
		const runtimeHelperContext = {
			env,
			callerContext,
			capabilityMap: {},
			provider,
			packageStorageTools,
			packageSecretTools,
			credentialClientTools,
			emailTools: closedWorldRetrieverRuntime ? undefined : options?.emailTools,
			workflowTools,
			packageEventTools: closedWorldRetrieverRuntime
				? undefined
				: options?.packageEventTools,
			computedPackageImportTools,
			staticCallMeterTools,
		}
		const runtimeHelperPreludes =
			createRuntimeHelperPreludes(runtimeHelperContext)
		const runtimeHelperPreludeSource =
			runtimeHelperPreludes.length > 0
				? `${runtimeHelperPreludes.join('\n')}\n`
				: ''
		// Mirrors the `__kodyRuntime` object below: a helper whose prelude is
		// omitted reaches the sandbox as `undefined` / `null`, so guard-less
		// access to it is what the unbound-helper error rewrite looks for.
		const unboundOptionalRuntimeHelperNames =
			createUnboundOptionalRuntimeHelperNames(runtimeHelperContext)
		const runtimeHelperRuntimePropertySource =
			createRuntimeHelperRuntimePropertySource()
		const wrapped = `async (__invocation = {}) => {
  const __kodyTrustedPackageContext = (() => {
    const incoming = __invocation.packageContext;
    if (incoming == null || typeof incoming !== 'object') return null;
    const snapshot = {
      packageId: incoming.packageId,
      kodyId: incoming.kodyId,
    };
    if ('sourceId' in incoming) snapshot.sourceId = incoming.sourceId;
    return Object.freeze(snapshot);
  })();
  const __kodyTrustedPackageId =
    typeof __kodyTrustedPackageContext?.packageId === 'string' &&
    __kodyTrustedPackageContext.packageId.trim() !== ''
      ? __kodyTrustedPackageContext.packageId
      : null;
${runtimeHelperPreludeSource}
  const { AsyncLocalStorage: __KodyAsyncLocalStorage } = await import('node:async_hooks');
  const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
  const __kodyGlobal = globalThis;
  const __kodyRuntimeStorage =
    __kodyGlobal[__kodyRuntimeStorageSymbol] ??
    (__kodyGlobal[__kodyRuntimeStorageSymbol] = new __KodyAsyncLocalStorage());
  const __kodyRuntime = {
    // Internal proxy. User modules reach it only via import { kody } from 'kody:runtime'.
    kody: ${kodyProviderEvaluateBindingName},
${runtimeHelperRuntimePropertySource}
    packageContext: __kodyTrustedPackageContext,
  };
  try {
    return await __kodyRuntimeStorage.run(__kodyRuntime, async () => {
      const __kodyModule = await import(${JSON.stringify(`./${bundle.mainModule}`)});
      const __kodyEntrypoint = __kodyModule?.default;
      if (typeof __kodyEntrypoint !== 'function') {
        throw new Error('Kody execute modules must default export a function.');
      }
      return await __kodyEntrypoint(__invocation.params);
    });
  } finally {
    // Deliver buffered static package export call usage events while the
    // sandbox RPC dispatchers are still live. Metering never breaks the
    // run it observes, and the bounded race keeps a slow metering bridge
    // from owning the run's tail latency.
    if (typeof __kodyStaticCallMeter !== 'undefined' && __kodyStaticCallMeter != null) {
      try {
        let __kodyStaticCallMeterFlushTimer;
        await Promise.race([
          __kodyStaticCallMeter.flush(),
          new Promise((resolve) => {
            __kodyStaticCallMeterFlushTimer = setTimeout(resolve, 2_000);
          }),
        ]);
        clearTimeout(__kodyStaticCallMeterFlushTimer);
      } catch {}
    }
  }
}`
		try {
			const providers: Array<ResolvedProvider> = [
				provider,
				...createRuntimeHelperExtraProviders(runtimeHelperContext),
			]
			await reportExecutePhaseProgress(reportProgress, 'sandbox')
			const sandboxStartedAtMs = Date.now()
			let result: ExecuteResult
			try {
				result = await runWithTransientDurableObjectResetRetry({
					operation: () =>
						executor.execute(wrapped, providers, {
							params,
							packageContext: options?.packageContext ?? null,
						}),
					retryableResultError: (executeResult) => executeResult.error ?? null,
					shouldRetry: ({ result: executeResult }) =>
						!evaluationHasHostMediatedSideEffects(
							executeResult?.hostMediatedSideEffects,
						),
					signal: options?.signal,
					onRetry: ({ attempt, nextDelayMs, error }) => {
						console.warn(
							JSON.stringify({
								message:
									'runBundledModuleWithRegistry transient Durable Object reset',
								attempt,
								nextDelayMs,
								errorMessage: getErrorMessage(error),
							}),
						)
					},
				})
			} finally {
				const sandboxMs = Date.now() - sandboxStartedAtMs
				runServerTiming.push({
					name: 'sandbox',
					durationMs: sandboxMs,
				})
				if (runRecordHandle) {
					runRecordHandle.context = {
						...runRecordHandle.context,
						metadata: {
							...runRecordHandle.context.metadata,
							sandboxMs,
						},
					}
				}
			}
			const sanitizedResult = sanitizeExecuteResult(result, secretRedactor)
			capturedLogs = sanitizedResult.logs
			if (!result.error) {
				staticCallRunFailed = false
				await finishObservedRun({
					status: 'success',
					logs: sanitizedResult.logs ?? [],
					result: sanitizedResult.result,
				})
				await recordPackageExportUsage('success')
				return withRunId(sanitizedResult)
			}
			const rewrittenMessage = rewriteUnboundRuntimeHelperError({
				error: result.error,
				modules: hydratedModules,
				unboundHelperNames: unboundOptionalRuntimeHelperNames,
			})
			const finalResult = rewrittenMessage
				? {
						...sanitizedResult,
						error: secretRedactor.redactErrorMessage(rewrittenMessage),
					}
				: sanitizedResult
			if (
				callerOwnsScheduledJobRun &&
				isTransientJobExecutionError(finalResult.error)
			) {
				// Leave the claimed run `running` so the job scheduler can
				// abandon it and retry the same scheduledFor. Finishing as
				// error would make the idempotency replay permanent — the
				// next claim would replay the terminal row instead of
				// retrying the occurrence (D1 blips, DO isolate resets,
				// storage-estimate misses). Buffered static-call throws are
				// not terminal fleet errors: rewrite them to `caught` on
				// finalize (same as a successful run that handled a throw).
				staticCallRunFailed = false
				return withRunId(finalResult)
			}
			const namedExecutionError = createNamedExecutionError(finalResult.error)
			await finishObservedRun({
				status: 'error',
				logs: finalResult.logs ?? [],
				error: namedExecutionError,
			})
			// Prefer TimeoutError naming for sandbox timeouts; keep the original
			// error otherwise so structured codes / names survive stringification.
			await recordPackageExportUsage(
				'error',
				namedExecutionError.name === 'TimeoutError'
					? namedExecutionError
					: finalResult.error,
			)
			return withRunId(finalResult)
		} catch (error) {
			if (leavesCallerRunRecordOpen(error)) {
				staticCallRunFailed = false
				throw error
			}
			if (!runRecordFinished) {
				const resolved = resolveThrownRunError(error)
				await finishObservedRun({
					status: 'error',
					logs: resolved.logs,
					error: resolved.error,
				})
			}
			throw error
		}
	} catch (error) {
		if (leavesCallerRunRecordOpen(error)) {
			staticCallRunFailed = false
			throw error
		}
		if (!runRecordFinished) {
			const resolved = resolveThrownRunError(error)
			await finishObservedRun({
				status: 'error',
				logs: resolved.logs,
				error: resolved.error,
			})
		}
		await recordPackageExportUsage('error', error)
		throw error
	} finally {
		// Host-side static-call writes can be up to 200 sequential rollups.
		// Prefer waitUntil so metering finishes after the response; otherwise
		// keep the same 2s bound as the sandbox flush race so a slow sink
		// cannot own the run's return latency.
		const finalizePromise = staticCallMeterTools?.finalize({
			runFailed: staticCallRunFailed,
		})
		if (!finalizePromise) {
			// No meter for this run.
		} else if (waitUntil) {
			waitUntil(finalizePromise)
		} else {
			try {
				let finalizeTimer: ReturnType<typeof setTimeout> | undefined
				await Promise.race([
					finalizePromise,
					new Promise<void>((resolve) => {
						finalizeTimer = setTimeout(resolve, 2_000)
					}),
				])
				clearTimeout(finalizeTimer)
			} catch {
				// Metering never breaks the run it observes.
			}
		}
	}
}
/**
 * A guard-less access to an unbound optional `kody:runtime` helper (for
 * example `email.getMessage(...)` outside an email-triggered run)
 * throws a bare TypeError that gives the caller no path to self-correct.
 * Enrich the message so `getExecutionErrorDetails` can attach a structured
 * next step naming the unbound helper.
 */
function rewriteUnboundRuntimeHelperError(input: {
	error: unknown
	modules: WorkerLoaderModules
	unboundHelperNames: ReadonlySet<string>
}) {
	const message = getErrorMessage(input.error)
	const access = findUnboundRuntimeHelperAccess({
		errorMessage: message,
		modules: input.modules,
		unboundHelperNames: input.unboundHelperNames,
	})
	if (!access) return null
	return createUnboundRuntimeHelperMessage({
		originalMessage: message,
		helperName: access.helperName,
		reference: access.reference,
	})
}

function trackPersistedSecretInputValues(
	capabilityName: string,
	args: Record<string, unknown>,
	track?: (value: string) => void,
) {
	if (!track) return
	if (capabilityName === 'secretSet' && typeof args.value === 'string') {
		track(args.value)
		return
	}
	if (capabilityName === 'secretSetMany' && Array.isArray(args.secrets)) {
		for (const entry of args.secrets) {
			if (isRecord(entry) && typeof entry.value === 'string') {
				track(entry.value)
			}
		}
	}
}

function sanitizeExecuteResult(
	result: ExecuteResult,
	secretRedactor: ExecutionSecretRedactor,
): ExecuteResult {
	return {
		...result,
		result: secretRedactor.redactUnknown(result.result),
		logs: Array.isArray(result.logs)
			? result.logs.map((entry) => secretRedactor.redactErrorMessage(entry))
			: result.logs,
		error: redactExecuteError(result.error, secretRedactor),
	}
}

function redactExecuteError(
	error: ExecuteResult['error'],
	secretRedactor: ExecutionSecretRedactor,
): ExecuteResult['error'] {
	if (error === undefined) return undefined
	const redacted = secretRedactor.redactUnknown(error)
	if (typeof redacted === 'string') return redacted
	if (redacted instanceof Error) return redacted.message
	return String(redacted)
}

function normalizeStorageContext(
	storageContext: McpCallerContext['storageContext'] | null,
) {
	if (!storageContext) return null
	return {
		sessionId: storageContext.sessionId ?? null,
		appId: storageContext.appId ?? null,
		packageId: storageContext.packageId ?? null,
		storageId: storageContext.storageId ?? null,
	}
}
