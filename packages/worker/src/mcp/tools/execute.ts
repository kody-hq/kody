import { ExecutionContextError } from '#worker/execution-contexts/errors.ts'
import {
	computeIncludeHeadsUpClaimTtlSeconds,
	computeIncludeHeadsUpKvKey,
	formatComputeIncludeHeadsUp,
} from '#mcp/compute-include-heads-up.ts'
import { orgUsagePath } from '#universal/org-pages.ts'
import { executionContextsFlagKey } from '#worker/execution-contexts/flag.ts'
import {
	type ExecuteRoutingArgs,
	executeRoutingInputFields,
	routeExecuteForCaller,
} from '#worker/execution-contexts/execute-routing.ts'
import {
	describeRanOn,
	describeRanOnWithWorkerUnits,
	ranOnFromMetadata,
	type ExecuteRanOn,
	type ExecutionContextRunMetadata,
} from '#worker/execution-contexts/routing.ts'
import * as Sentry from '@sentry/cloudflare'
import {
	type ContentBlock,
	type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	callerFeatureFlagEvaluationFailed,
	resolveCallerFeatureFlags,
} from '#mcp/capabilities/access-control.ts'
import { runWithRequestPermissions } from '#worker/authorization/authorize.ts'
import {
	executeInvokeRemovedMessage,
	hasRemovedExecuteInvoke,
} from '#mcp/execute-invoke-removed.ts'
import { buildExecuteAttributionMetadata } from '#worker/run-records/execute-attribution.ts'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import {
	defaultExecutionResponseLimitBytes,
	formatLimitedExecutionOutput,
	limitExecutionResultValue,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import { entitlementStructuredContent } from '#mcp/entitlement-metadata.ts'
import {
	defaultMcpContentLimitBytes,
	extractMcpPassthrough,
	limitMcpContentBlocks,
	validateDownstreamMcpContentBlocks,
} from '#mcp/downstream-mcp-result.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { getInboundRequestSignal } from '#mcp/inbound-request-signal.ts'
import { runModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import {
	credentialCallMapSchema,
	normalizeCredentialCallMap,
	type CredentialCallMapInput,
} from '#worker/credentials/credential-call-map.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { createProgressReporter, type McpToolCallExtra } from '#mcp/progress.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from './tool-call-context.ts'
import {
	buildMemoryRetrievalQuery,
	buildMemoryStructuredContent,
	formatSurfacedMemoriesMarkdown,
	surfaceToolMemories,
} from './memory-tool-context.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'
import { buildKodyToolIcons } from './tool-icons.ts'
import {
	applyRawFetchHostCounts,
	codeUsesIntegrationAuthHelpers,
	createRawFetchHostSink,
	type RawFetchHostNudgeState,
} from '#mcp/raw-fetch-host-nudge.ts'
import {
	applyPreferLocalExecuteNudge,
	dailyFreshWorkersFromClaim,
	isKnownWebOnlyMcpClient,
	monthlyIncludeForPreferLocalNudge,
	preferLocalNudgeMonthKey,
	shouldTipPreferLocalExecuteNudge,
} from '#mcp/prefer-local-execute-nudge.ts'
import { isPreRunUsageDenial } from '#worker/entitlements/errors.ts'
import { readMonthlyComputeUsage } from '#worker/billing/compute-overage-usage.ts'
import {
	getCachedUserEntitlement,
	readExecuteUniqueWorkerUsage,
} from '#worker/entitlements/service.ts'
import {
	admitHostedExecuteCall,
	buildExecuteUsageReport,
	claimedUsageForNow,
	type ClaimedExecuteUsage,
	createExecuteWorkerDayClaim,
	executeAdmissionStructuredContent,
	executeLoopDetectedErrorCode,
	executeRateLimitedErrorCode,
	executeRepeatKey,
} from '#mcp/execute-admission.ts'
import {
	createDefaultExecuteIdempotencyKey,
	createDetachableAbortSignal,
	remainingTransportBudgetMs,
	watchExecuteTransport,
} from '#mcp/execute-transport-budget.ts'
import {
	abandonRunRecord,
	beginRunRecord,
	claimRunRecord,
	ensureRunRecordStarted,
	updateRunningRunRecordMetadata,
	finishRunRecord,
	getRunRecord,
	getRunRecordByIdempotencyKey,
} from '#worker/run-records/service.ts'
import {
	runRecordMaxIdempotencyKeyLength,
	type RunRecord,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { scheduleFleetExecuteLastSuccess } from '#worker/execute-health-heartbeat.ts'
import {
	entitlementEmailForOwner,
	ownerIdFromCaller,
} from '#worker/request-context/owner-id.ts'
import { type StructuredContentFromFields } from './mcp-tool-output.ts'

export const executeTool = {
	name: 'execute',
	title: 'Execute code',
	description: executeToolDescription,
	annotations: {
		readOnlyHint: false,
		// Execute can delete, overwrite, send, revoke, or otherwise make
		// irreversible changes depending on the module and capabilities called.
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	} satisfies ToolAnnotations,
} as const

/**
 * Advertised MCP output schema for the execute tool's `structuredContent`
 * envelope. This record is the single source of truth for tools/list JSON
 * Schema and {@link ExecuteToolStructuredContent}. Keep every top-level key
 * responses emit here — strict clients (Claude Code, MCP SDK Ajv) reject
 * undeclared fields with `additionalProperties: false`. Compound values stay
 * `z.unknown()` so server-side Zod validation never rejects a real response;
 * the module return value stays `unknown` by construction.
 */
export const executeToolOutputSchema = {
	conversationId: z
		.string()
		.optional()
		.describe(
			'Tool conversation id; pass it back on subsequent search/execute calls.',
		),
	timing: z
		.unknown()
		.optional()
		.describe(
			'Server-side timing: startedAt, endedAt, durationMs, optional serverTiming phases.',
		),
	runId: z
		.string()
		.optional()
		.describe(
			'Run record id. When the call is still running at the transport budget, poll runGet with this id.',
		),
	idempotencyKey: z
		.string()
		.optional()
		.describe(
			'Caller-supplied or server-assigned idempotency key. Present on a transport-budget follow response. Retry execute with this key to read the same run.',
		),
	inProgress: z
		.boolean()
		.optional()
		.describe(
			'True when a keyed retry found the original run still executing.',
		),
	status: z
		.string()
		.optional()
		.describe('Run status accompanying inProgress lookups.'),
	replayed: z
		.boolean()
		.optional()
		.describe('True when a keyed retry returned a retained earlier result.'),
	returnedBytes: z
		.number()
		.optional()
		.describe('Serialized size of the returned value.'),
	truncated: z
		.boolean()
		.optional()
		.describe('True when the result was truncated to fit responseLimit.'),
	note: z.string().optional().describe('Truncation note when truncated.'),
	result: z
		.unknown()
		.optional()
		.describe("The module default export's return value (arbitrary JSON)."),
	error: z
		.string()
		.optional()
		.describe('Error summary when execution failed (isError is set).'),
	errorName: z.string().optional().describe('Error name for replayed errors.'),
	errorDetails: z
		.unknown()
		.optional()
		.describe('Structured details for sandbox errors.'),
	entitlement: z
		.unknown()
		.optional()
		.describe(
			'Focused plan-limit or quota fields when a call is denied. Omitted from ordinary successes.',
		),
	usage: z
		.unknown()
		.optional()
		.describe(
			'Hosted execute allowance after this call: unit, and per window (day, plus week when the plan has one) used, limit, remaining, resetsAt. Repeats of code already run today do not count.',
		),
	admission: z
		.object({
			code: z.enum([executeRateLimitedErrorCode, executeLoopDetectedErrorCode]),
			retryAfterMs: z.number(),
		})
		.optional()
		.describe(
			'Set when a runaway or loop brake refused the call before it ran: the refusal code and how long to wait before the same call is admitted.',
		),
	logs: z
		.array(z.unknown())
		.optional()
		.describe('Console output captured from the sandboxed module.'),
	warnings: z
		.array(z.string())
		.optional()
		.describe(
			'Server guidance, e.g. raw-fetch host nudges, or the once-a-month usage heads-up when this workspace has used 80% or more of its included Worker compute.',
		),
	memories: z
		.unknown()
		.optional()
		.describe('Relevant stored memories surfaced for this call.'),
	ranOn: z
		.unknown()
		.optional()
		.describe(
			'Where the run happened, on every routed response (input errors before routing may omit it): { kind: "cloud" | "context", id: "cloud" | context id, name: "Kody cloud" | context name, yours?, timing?, attempts, fellBackToCloud, workerUnits? }. workerUnits is the Worker compute units charged by the worker of this call: 0 on an execution context or when that worker already ran today, 1 when Kody cloud started it today; omitted while a cloud run is still in progress. attempts lists contexts that passed on it (offline, busy, skipped) with reasons. timing (ms, context runs that reported it): queueMs, setupMs (packageGraphMs, packageGraphCached), executeMs and daemonMs on the machine, serverMs on Kody, transitMs = serverMs - daemonMs for dispatch plus return.',
		),
	executionContext: z
		.unknown()
		.optional()
		.describe(
			'Legacy detail for runs that involved an execution context (same attempts and fellBackToCloud as ranOn). Prefer ranOn.',
		),
}

export type ExecuteToolStructuredContent = StructuredContentFromFields<
	typeof executeToolOutputSchema
>

/** Longest a detached context run waits for its main run record to start. */
const runRecordStartWaitMs = 2_000

const executeCodeRequiredMessage =
	'execute requires `code`: a single ESM module string with a default export.'

function executeCodeMissingError(issue: { input: unknown }) {
	return issue.input === undefined ? executeCodeRequiredMessage : undefined
}

const executeCodeFieldDescription =
	'Single ESM module string with imports/exports and a default export to execute. Imports may be arbitrary npm packages compatible with the Cloudflare Workers runtime; prefer packages over rewriting helpers.'

export async function registerExecuteTool(agent: McpRegistrationAgent) {
	const icons = buildKodyToolIcons(agent.getCallerContext().baseUrl)
	const featureFlags = await resolveCallerFeatureFlags(
		agent.getEnv(),
		agent.getCallerContext(),
	)
	const executionContextsEnabled =
		featureFlags[executionContextsFlagKey] === true
	agent.server.registerTool(
		executeTool.name,
		{
			title: executeTool.title,
			description: executeTool.description,
			outputSchema: executeToolOutputSchema,
			...(icons ? { icons } : {}),
			inputSchema: z
				.object({
					code: z
						.string({ error: executeCodeMissingError })
						.describe(executeCodeFieldDescription),
					params: z
						.record(z.string(), z.unknown())
						.optional()
						.describe(
							'JSON object passed as the first argument to the default export. Put varying capability args here so the same `code` graph is reused.',
						),
					responseLimit: z
						.number()
						.int()
						.min(1)
						.optional()
						.describe(
							"Soft cap on the default export's JSON/text result. Oversized results are truncated. Project large API payloads before returning. Protocol __mcpContent media uses a separate limit and fails explicitly when oversized; oversized text-only protocol content is truncated.",
						),
					conversationId: conversationIdInputField,
					memoryContext: memoryContextInputField,
					idempotencyKey: z
						.string()
						.min(1)
						.max(runRecordMaxIdempotencyKeyLength)
						.optional()
						.describe(
							'Optional idempotency key. Omit it for ordinary calls. If the call is still running at the transport budget, Kody assigns one and returns it with runId. Reuse that key to read the in-progress or retained run instead of starting the mutation again.',
						),
					credentials: credentialCallMapSchema.optional(),
					...(executionContextsEnabled ? executeRoutingInputFields : {}),
				})
				// Unknown keys pass through so a removed `invoke` reaches the
				// check below instead of being silently stripped.
				.loose()
				.refine((args) => !hasRemovedExecuteInvoke(args), {
					error: (issue) =>
						executeInvokeRemovedMessage(
							(issue.input as Record<string, unknown>)['invoke'],
						),
					path: ['invoke'],
					when: () => true,
				}),
			annotations: executeTool.annotations,
		},
		async (args, toolExtra) =>
			runExecuteToolCall({
				env: agent.getEnv(),
				callerContext: agent.getCallerContext(),
				loopbackExports: agent.getLoopbackExports(),
				waitUntil: agent.waitUntil?.bind(agent),
				mcpAgent: agent,
				args,
				extra: toolExtra,
			}),
	)
}

export type ExecuteToolCallArgs = {
	code?: string
	params?: Record<string, unknown>
	responseLimit?: number
	conversationId?: string
	memoryContext?: z.infer<typeof memoryContextInputField>
	idempotencyKey?: string
	credentials?: CredentialCallMapInput
} & ExecuteRoutingArgs

export async function runExecuteToolCall(input: {
	env: Env
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	loopbackExports: Cloudflare.Exports
	waitUntil?: (promise: Promise<unknown>) => void
	mcpAgent?: McpRegistrationAgent
	args: ExecuteToolCallArgs
	extra?: McpToolCallExtra
	/** Cheap display label for started_by (API token name). Never a secret. */
	startedByLabel?: string | null
}) {
	const {
		code,
		params,
		responseLimit,
		conversationId,
		memoryContext,
		idempotencyKey,
		credentials,
	} = input.args
	const timingStart = startToolTiming()
	const env = input.env
	// Hand terminal run-record writes and nested-invocation
	// observability to the caller's waitUntil so they stop
	// serializing the execute response they observe.
	const waitUntil = input.waitUntil
	const reportProgress = createProgressReporter(input.extra)
	const callerContext = input.callerContext
	const resolvedConversationId = resolveConversationId(conversationId)
	const {
		baseUrl,
		hasUser,
		userId,
		storageId: boundStorageId,
	} = callerContextFields(callerContext)
	const activeStorageId = boundStorageId ?? null
	const mcpCallerFields = {
		baseUrl,
		hasUser,
		userId,
		conversationId: resolvedConversationId,
		...(activeStorageId ? { storageId: activeStorageId } : {}),
	}
	let claimedRunHandle: RunRecordHandle | null = null
	let runRowOwned = false
	let transportDetached = false
	let detachTransportAfterResponse = false
	let transportSignal: ReturnType<typeof createDetachableAbortSignal> | null =
		null
	let claimedExecuteUsage: ClaimedExecuteUsage | null = null
	let chargedWorkerUnits = 0
	const response = await attachExecuteUsage(
		attachWorkerUnits(await runExecuteToolWithErrorBoundary()),
	)
	// Detach only after the follow response is built, including the
	// usage read. A caller cancel before that still stops the sandbox.
	// Nested-function assignments are invisible to TS control-flow
	// analysis on the outer lets, so reassert the declared type.
	const signalAfterResponse = transportSignal as ReturnType<
		typeof createDetachableAbortSignal
	> | null
	if (detachTransportAfterResponse && signalAfterResponse) {
		if (!signalAfterResponse.signal.aborted) {
			signalAfterResponse.detach()
		}
		transportDetached = true
	}
	return response

	/**
	 * Units this call's own worker charged, on `ranOn` and its text line.
	 * Context runs never claim one; a cloud run still in progress has not
	 * settled yet, so it is left out until runGet.
	 */
	function attachWorkerUnits<
		Response extends {
			content: Array<ContentBlock>
			structuredContent: Record<string, unknown>
		},
	>(response: Response): Response {
		const ranOn = response.structuredContent['ranOn'] as
			| ExecuteRanOn
			| undefined
		if (!ranOn || typeof ranOn !== 'object' || !('kind' in ranOn)) {
			return response
		}
		if (
			ranOn.kind === 'cloud' &&
			response.structuredContent['inProgress'] === true
		) {
			return response
		}
		const workerUnits = ranOn.kind === 'context' ? 0 : chargedWorkerUnits
		const lines = new Set([
			describeRanOn(ranOn),
			describeRanOn(ranOn, { running: true }),
		])
		return {
			...response,
			content: response.content.map((block) =>
				block.type === 'text' && lines.has(block.text)
					? {
							...block,
							text: describeRanOnWithWorkerUnits(block.text, workerUnits),
						}
					: block,
			),
			structuredContent: {
				...response.structuredContent,
				ranOn: { ...ranOn, workerUnits },
			},
		}
	}

	async function attachExecuteUsage<
		Response extends { structuredContent: Record<string, unknown> },
	>(response: Response): Promise<Response> {
		const ownerId = ownerIdFromCaller(callerContext)
		if (!callerContext.user?.userId || !ownerId) return response
		const now = new Date()
		const usage =
			claimedUsageForNow(claimedExecuteUsage, now) ??
			(await readExecuteUniqueWorkerUsage({
				db: env.APP_DB,
				env,
				userId: ownerId,
				email: entitlementEmailForOwner(callerContext, ownerId),
				now,
			}).catch((error: unknown) => {
				console.warn('execute-usage-read-failed', error)
				return null
			}))
		if (!usage) return response
		return {
			...response,
			structuredContent: {
				...response.structuredContent,
				usage: buildExecuteUsageReport(usage, now),
			},
		}
	}

	async function runExecuteToolWithErrorBoundary() {
		try {
			return await runExecuteTool()
		} catch (cause) {
			// Setup failures (registry build, module bundling, executor
			// creation) must return a structured MCP error instead of an
			// unhandled rejection, mirroring the search tool boundary.
			// Finalize any pre-claimed keyed run so retries can replay the
			// error instead of seeing a stuck `running` row.
			// Nested-function assignments are invisible to TS control-flow
			// analysis on the outer `let`, so reassert the declared type.
			const claimedHandle = claimedRunHandle as RunRecordHandle | null
			// Setup failures happen before sandbox work: release the key so
			// a later retry is not poisoned by a non-sandbox error. A
			// transport-budget detach already handed the caller this run,
			// so abandoning it would delete the handle they are polling.
			if (claimedHandle && !transportDetached) {
				await abandonRunRecord({ env, handle: claimedHandle })
			}
			const timing = finishToolTiming(timingStart)
			const error = cause instanceof Error ? cause : new Error(String(cause))
			const { errorName, errorMessage } = errorFields(error)
			const errorDetails = getExecutionErrorDetails(error, {
				orgSlug: callerContext.request?.org.slug,
			})
			logMcpEvent({
				category: 'mcp',
				tool: 'execute',
				toolName: 'execute',
				outcome: 'failure',
				durationMs: timing.durationMs,
				...mcpCallerFields,
				sandboxError: false,
				errorName,
				errorMessage,
				cause: error,
			})
			return {
				content: prependToolMetadataContent(resolvedConversationId, [
					{ type: 'text', text: `Error: ${error.message}` },
				]),
				structuredContent: {
					conversationId: resolvedConversationId,
					timing,
					error: error.message,
					...(errorDetails ? { errorDetails } : {}),
					...entitlementStructuredContent(error),
					...executeAdmissionStructuredContent(error),
					...(error instanceof ExecutionContextError
						? { errorCode: error.code, ...error.details }
						: {}),
				},
				isError: true,
			}
		}
	}

	async function runExecuteTool() {
		const normalizedIdempotencyKey =
			normalizeExecuteIdempotencyKey(idempotencyKey)
		// Look up an existing keyed execute run before admission so
		// transport-timeout retries can replay / report in-progress
		// without spending the runaway brake or loading a worker.
		const storageOwnerId = ownerIdFromCaller(callerContext)
		const entitlementEmail = entitlementEmailForOwner(
			callerContext,
			storageOwnerId,
		)
		if (normalizedIdempotencyKey && storageOwnerId) {
			const existing = await getRunRecordByIdempotencyKey({
				env,
				userId: storageOwnerId,
				idempotencyKey: normalizedIdempotencyKey,
				surface: 'execute',
			})
			if (existing) {
				const timing = finishToolTiming(timingStart)
				return buildKeyedExecuteLookupResponse({
					run: existing,
					conversationId: resolvedConversationId,
					timing,
				})
			}
		}

		// Re-read caller flags per call so a kill-switch applies on the
		// next call even when the tool was registered earlier. Plan lookup overlaps that read. The daily counter is spent
		// only after the read succeeds — an evaluation failure is
		// fail-closed and must not consume quota.
		const liveFlagsPromise = resolveCallerFeatureFlags(env, callerContext)
		const entitlementPrefetch = callerContext.user?.userId
			? getCachedUserEntitlement(env.APP_DB, {
					userId: storageOwnerId,
					email: entitlementEmail,
				}).then(
					() => undefined,
					() => undefined,
				)
			: null
		const liveFlags = await liveFlagsPromise
		if (await callerFeatureFlagEvaluationFailed(env, callerContext)) {
			throw new Error('Feature flag evaluation failed')
		}
		void entitlementPrefetch
		// Registry assembly starts before quota to overlap the quota check.
		// It is awaited only after quota and a fresh idempotency claim, so a
		// denied call does not run bundled package code.
		const registryPromise = getCapabilityRegistryForContext({
			env,
			callerContext,
		})
		void registryPromise.catch(() => {})
		if (hasRemovedExecuteInvoke(input.args)) {
			throw new McpCallerError(executeInvokeRemovedMessage(input.args.invoke))
		}
		const moduleCode = code?.trim() ? code : undefined
		if (!moduleCode) {
			throw new McpCallerError(executeCodeRequiredMessage)
		}
		const executeRunMetadata = {
			conversationId: resolvedConversationId,
			...buildExecuteAttributionMetadata(),
		}

		// Runaway and loop brakes before claim/bundling/sandbox so a refused call
		// costs nothing and does not poison a key. The plan cap counts
		// unique workers and is spent inside the executor, once the
		// worker id is known and before that worker loads.
		const claimWorkerDay =
			callerContext.user?.userId && storageOwnerId
				? createExecuteWorkerDayClaim({
						env,
						ownerId: storageOwnerId,
						email: entitlementEmail,
						onUsage: (claimed) => {
							claimedExecuteUsage = claimed
							if (claimed.usage.created) chargedWorkerUnits += 1
						},
						waitUntil,
						orgBudget: callerContext.request
							? {
									orgId: callerContext.request.org.id,
									orgSlug: callerContext.request.org.slug,
									actorUserId: callerContext.request.actor?.userId ?? null,
									actorUsername: callerContext.request.actor?.username ?? null,
								}
							: undefined,
					})
				: undefined
		// Admission is a UserMeter round trip that only gates work below it,
		// so let it overlap the registry read; nothing that writes, retrieves
		// memories, or runs sandbox code proceeds until it has admitted.
		const normalizedCallMap = normalizeCredentialCallMap(credentials)
		// Runs on an execution context never count toward hosted quota, so
		// when routing is possible admission waits until routing picks cloud.
		const deferAdmission =
			Boolean(claimWorkerDay) && liveFlags[executionContextsFlagKey] === true
		const startAdmission = async () =>
			claimWorkerDay
				? admitHostedExecuteCall({
						env,
						ownerId: storageOwnerId,
						email: entitlementEmail,
						repeatKey: await executeRepeatKey({
							credential: callerContext.request?.credential ?? null,
							actorUserId:
								callerContext.request?.actor?.userId ??
								callerContext.user?.userId ??
								null,
							conversationId,
							code: moduleCode,
							params,
							credentials: normalizedCallMap,
						}),
					})
				: null
		let admissionPromise = deferAdmission ? null : startAdmission()
		void admissionPromise?.catch(() => {})

		if (storageOwnerId) {
			// Claim or begin before sandbox work so a transport-budget
			// follow response already has a run id. Caller-supplied keys
			// stay on the awaited claim path. Omitted keys get a
			// server-assigned key without failing the call when RUN_LOG
			// cannot record one.
			await admissionPromise
		}
		const executeStartedByLabel = input.startedByLabel?.trim() || null
		if (normalizedIdempotencyKey && storageOwnerId) {
			const claim = await claimRunRecord({
				env,
				userId: storageOwnerId,
				request: callerContext.request,
				startedByLabel: executeStartedByLabel,
				context: {
					surface: 'execute',
					name: null,
					storageId: activeStorageId,
					idempotencyKey: normalizedIdempotencyKey,
					metadata: executeRunMetadata,
				},
			})
			if (!claim) {
				throw new Error(
					'Unable to claim execute idempotency key; RUN_LOG is unavailable.',
				)
			}
			if (!claim.claimed) {
				const timing = finishToolTiming(timingStart)
				return buildKeyedExecuteLookupResponse({
					run: claim.run,
					conversationId: resolvedConversationId,
					timing,
				})
			}
			claimedRunHandle = claim.handle
			runRowOwned = true
		} else if (storageOwnerId) {
			const generatedKey = createDefaultExecuteIdempotencyKey()
			claimedRunHandle = beginRunRecord({
				env,
				userId: storageOwnerId,
				waitUntil,
				request: callerContext.request,
				startedByLabel: executeStartedByLabel,
				context: {
					surface: 'execute',
					name: null,
					storageId: activeStorageId,
					idempotencyKey: generatedKey,
					metadata: executeRunMetadata,
				},
			})
		}

		// Registry assembly and memory retrieval can run package code.
		// The transport deadline covers that setup plus the sandbox, so a
		// slow prelude still returns a follow handle before the client
		// drops the tools/call.
		let surfacedMemories: Awaited<
			ReturnType<typeof surfaceToolMemories>
		> | null = null
		let registeredCapabilityCount = 0
		const rawFetchHosts = createRawFetchHostSink()
		const credentialCallMapWarnings: Array<string> = []
		transportSignal = createDetachableAbortSignal(getInboundRequestSignal())
		const activeTransportSignal = transportSignal
		const recordDetachedExecuteFailure = async (cause: unknown) => {
			if (!claimedRunHandle) return
			try {
				const current = await getRunRecord({
					env,
					userId: claimedRunHandle.userId,
					runId: claimedRunHandle.id,
				}).catch(() => null)
				if (current && current.run.status !== 'running') return
				// The caller already left with this run id. Persist the
				// failure for runGet even if the running row is not
				// readable yet. finish upserts the terminal row.
				await finishRunRecord({
					env,
					handle: claimedRunHandle,
					status: 'error',
					error: cause,
				})
			} catch (error) {
				console.warn('execute-transport-budget-finish-failed', error)
			}
		}
		const readTransportBudgetFollow = async (handle: RunRecordHandle) => {
			let started = false
			let current: { run: RunRecord } | null = null
			try {
				started = await ensureRunRecordStarted({ env, handle })
				current = await getRunRecord({
					env,
					userId: handle.userId,
					runId: handle.id,
				})
			} catch (error) {
				console.warn('execute-transport-budget-read-failed', error)
			}
			if (current && current.run.status !== 'running') {
				return {
					transportFollow: 'terminal' as const,
					run: current.run,
				}
			}
			// A caller-supplied claim already owns the key. A generated
			// key is advertised only after the running row is readable,
			// so a retry cannot claim the same key and start a second
			// sandbox.
			const keyOwned = runRowOwned || started || Boolean(current)
			const idempotencyKey = keyOwned
				? (handle.context.idempotencyKey?.trim() ?? '')
				: ''
			await reportProgress?.({
				progress: 1,
				message: idempotencyKey
					? `Still running (runId: ${handle.id}). Poll runGet. idempotencyKey: ${idempotencyKey}.`
					: `Still running (runId: ${handle.id}). Poll runGet. Do not start another mutation.`,
			})
			return {
				transportFollow: 'running' as const,
				runId: handle.id,
				idempotencyKey,
			}
		}
		const routed = await routeExecuteForCaller({
			env,
			callerContext,
			args: input.args,
			enabled: liveFlags[executionContextsFlagKey] === true,
			runRecord: claimedRunHandle,
			code: moduleCode,
			params,
			conversationId: resolvedConversationId,
			credentials: normalizedCallMap,
			waitMs: remainingTransportBudgetMs({
				startedAtMs: timingStart.startedAtMs,
			}),
			signal: activeTransportSignal.signal,
		})
		if (routed?.kind === 'cloud' && routed.metadata) {
			Object.assign(executeRunMetadata, {
				executionContext: routed.metadata,
			})
			if (claimedRunHandle) {
				claimedRunHandle.context.metadata = {
					...claimedRunHandle.context.metadata,
					executionContext: routed.metadata,
				}
				// Best-effort and never throws; routing must not wait on it. The
				// running-row check keeps a late write off a finished run.
				const metadataWrite = updateRunningRunRecordMetadata({
					env,
					handle: claimedRunHandle,
				})
				if (waitUntil) waitUntil(metadataWrite)
				else void metadataWrite
			}
		}
		const { ranOnContent, ranOnFields } = ranOnParts(
			routed?.kind === 'cloud' ? routed.metadata : null,
		)
		if (routed?.kind === 'pending' || routed?.kind === 'queued') {
			transportDetached = true
			// The context finishes this row later; make sure the running row
			// (idempotency key, started_by) is readable before the caller polls.
			const started = claimedRunHandle
				? await Promise.race([
						ensureRunRecordStarted({ env, handle: claimedRunHandle }).catch(
							(error: unknown) => {
								console.warn('execute-context-run-start-failed', error)
								return false
							},
						),
						new Promise<false>((resolve) =>
							setTimeout(resolve, runRecordStartWaitMs, false),
						),
					])
				: false
			const timing = finishToolTiming(timingStart)
			return buildTransportBudgetFollowResponse({
				conversationId: resolvedConversationId,
				timing,
				runId: routed.runId,
				idempotencyKey:
					runRowOwned || started
						? (claimedRunHandle?.context.idempotencyKey?.trim() ?? '')
						: '',
				memories: null,
				executionContext: routed.metadata,
			})
		}
		if (routed?.kind === 'ran') {
			transportDetached = true
			const timing = finishToolTiming(timingStart)
			const ranOnContext = ranOnParts(routed.metadata)
			return {
				content: prependToolMetadataContent(resolvedConversationId, [
					...(routed.result.content as Array<ContentBlock>),
					...ranOnContext.ranOnContent,
				]),
				structuredContent: {
					...routed.result.structuredContent,
					conversationId: resolvedConversationId,
					timing,
					...(claimedRunHandle ? { runId: claimedRunHandle.id } : {}),
					...ranOnContext.ranOnFields,
				},
				isError: routed.result.isError,
			}
		}
		if (deferAdmission) {
			admissionPromise = startAdmission()
			await admissionPromise
		}
		const admittedWork = (async () => {
			const [registry] = await Promise.all([registryPromise, admissionPromise])
			registeredCapabilityCount = Object.keys(
				registry.capabilityHandlers,
			).length
			surfacedMemories = await surfaceToolMemories({
				env,
				callerContext,
				conversationId: resolvedConversationId,
				retrievalQuery: buildMemoryRetrievalQuery(memoryContext),
			})
			const credentialCallMap = normalizedCallMap
				? {
						map: normalizedCallMap,
						strict: false,
						onWarnings: (warnings: Array<string>) => {
							credentialCallMapWarnings.push(...warnings)
						},
					}
				: null
			return await Sentry.startSpan(
				{
					name: 'mcp.tool.execute',
					op: 'mcp.tool',
					attributes: {
						'mcp.tool': 'execute',
					},
				},
				async () => {
					try {
						const execution = runWithRequestPermissions(
							{ env, request: callerContext.request },
							async () =>
								runModuleWithRegistry(env, callerContext, moduleCode, params, {
									executorExports: input.loopbackExports,
									capabilityRegistry: registry,
									rawFetchHostSink: rawFetchHosts.sink,
									conversationId: resolvedConversationId,
									runRecordHandle: claimedRunHandle,
									claimWorkerDay,
									credentialCallMap,
									waitUntil,
									reportProgress: reportProgress ?? undefined,
									signal: activeTransportSignal.signal,
									runRecord: {
										surface: 'execute',
										name: null,
										storageId: activeStorageId,
										idempotencyKey:
											claimedRunHandle?.context.idempotencyKey ??
											normalizedIdempotencyKey,
										metadata: executeRunMetadata,
									},
								}),
						)
						const settled = execution.then(
							async (value) => {
								if (transportDetached && !value.error) {
									const passthrough = extractMcpPassthrough(value.result)
									if (!passthrough?.isError) {
										await scheduleFleetExecuteLastSuccess({
											waitUntil,
											kv: env.BUNDLE_ARTIFACTS_KV,
										})
									}
								}
								return value
							},
							async (cause: unknown) => {
								if (transportDetached) {
									await recordDetachedExecuteFailure(cause)
								}
								throw cause
							},
						)
						return await settled
					} catch (cause) {
						if (transportDetached && claimedRunHandle) {
							const idempotencyKey = runRowOwned
								? (claimedRunHandle.context.idempotencyKey?.trim() ?? '')
								: ''
							return {
								transportFollow: 'running' as const,
								runId: claimedRunHandle.id,
								idempotencyKey,
							}
						}
						// A usage denial happens before the worker loads: the
						// outer boundary releases the key, as for any other
						// pre-sandbox refusal.
						if (isPreRunUsageDenial(cause)) throw cause
						// Bundling the caller-provided module (syntax errors,
						// unresolved imports) throws before the sandbox runs;
						// route it through the sandbox-error result path so it
						// is not logged as a platform failure. Finish a still-
						// running claimed row only — if the registry already
						// wrote a terminal row, do not double-finish.
						if (claimedRunHandle) {
							const current = await getRunRecord({
								env,
								userId: claimedRunHandle.userId,
								runId: claimedRunHandle.id,
							}).catch(() => null)
							if (!current || current.run.status === 'running') {
								await finishRunRecord({
									env,
									handle: claimedRunHandle,
									status: 'error',
									error: cause,
								})
							}
						}
						return {
							result: undefined,
							error: getErrorMessage(cause),
							logs: [],
							...(claimedRunHandle ? { runId: claimedRunHandle.id } : {}),
						}
					}
				},
			)
		})()
		let transportBudgetFollow = false
		const observedAdmittedWork = admittedWork.then(
			() => undefined,
			async (cause: unknown) => {
				// Registry or memory can fail after we commit to a follow
				// response and before the sandbox promise exists. Record
				// that on the run the caller is polling. `transportDetached`
				// flips only after the usage read, which is too late.
				if (!transportDetached && !transportBudgetFollow) return
				await recordDetachedExecuteFailure(cause)
			},
		)
		waitUntil?.(observedAdmittedWork)
		let spanned:
			| Awaited<typeof admittedWork>
			| Awaited<ReturnType<typeof readTransportBudgetFollow>>
		if (!claimedRunHandle) {
			spanned = await admittedWork
		} else {
			const watched = watchExecuteTransport(
				admittedWork,
				remainingTransportBudgetMs({
					startedAtMs: timingStart.startedAtMs,
				}),
			)
			const raced = await watched.raced
			if (raced.kind === 'budget') {
				await Promise.resolve()
				const peeked = watched.peek()
				if (peeked?.ok === true) {
					spanned = peeked.value
				} else if (peeked && peeked.ok === false) {
					throw peeked.error
				} else {
					// Stay attached while the run row is confirmed. A caller
					// cancel during that read must still stop the sandbox.
					// Detach only once the follow response is about to return,
					// so completing the HTTP response does not cancel the work.
					transportBudgetFollow = true
					const follow = await readTransportBudgetFollow(claimedRunHandle)
					// A caller cancel does not overwrite an in-flight success
					// with client_disconnected, and the response still carries
					// the run id. The abort signal stays attached, so a sandbox
					// that is still running stops through its own handler.
					if (follow.transportFollow === 'terminal') {
						activeTransportSignal.detach()
						transportDetached = true
					} else {
						detachTransportAfterResponse = true
					}
					spanned = follow
				}
			} else if (raced.kind === 'rejected') {
				throw raced.error
			} else {
				spanned = raced.value
			}
		}
		if (
			'transportFollow' in spanned &&
			spanned.transportFollow === 'terminal'
		) {
			const timing = finishToolTiming(timingStart)
			const outcome = spanned.run.status === 'error' ? 'failure' : 'success'
			logMcpEvent({
				category: 'mcp',
				tool: 'execute',
				toolName: 'execute',
				outcome,
				durationMs: timing.durationMs,
				...mcpCallerFields,
				registeredCapabilityCount,
				sandboxError: outcome === 'failure',
				context: { transportBudgetFollow: true, runId: spanned.run.id },
			})
			return buildKeyedExecuteLookupResponse({
				run: spanned.run,
				conversationId: resolvedConversationId,
				timing,
			})
		}
		if ('transportFollow' in spanned && spanned.transportFollow === 'running') {
			const timing = finishToolTiming(timingStart)
			logMcpEvent({
				category: 'mcp',
				tool: 'execute',
				toolName: 'execute',
				outcome: 'success',
				durationMs: timing.durationMs,
				...mcpCallerFields,
				registeredCapabilityCount,
				sandboxError: false,
				context: {
					transportBudgetFollow: true,
					runId: spanned.runId,
				},
			})
			return buildTransportBudgetFollowResponse({
				conversationId: resolvedConversationId,
				timing,
				runId: spanned.runId,
				idempotencyKey: spanned.idempotencyKey,
				memories: surfacedMemories,
				executionContext: routed?.kind === 'cloud' ? routed.metadata : null,
			})
		}
		const result = spanned
		const timing = {
			...finishToolTiming(timingStart),
			...(result.serverTiming && result.serverTiming.length > 0
				? { serverTiming: result.serverTiming }
				: {}),
		}
		const durationMs = timing.durationMs
		const rawFetchHostNudges = [
			...credentialCallMapWarnings,
			...(await resolveRawFetchHostNudges({
				agent: input.mcpAgent ?? agentlessNudgeState(),
				env,
				callerContext,
				conversationId: resolvedConversationId,
				hostCounts: rawFetchHosts.hostCounts(),
				usedIntegrationAuthHelpers: codeUsesIntegrationAuthHelpers(moduleCode),
			})),
			...(await resolvePreferLocalExecuteNudges({
				agent: input.mcpAgent ?? agentlessNudgeState(),
				env,
				callerContext,
				conversationId: resolvedConversationId,
				claimed: claimedExecuteUsage,
			})),
			...(await resolveComputeIncludeHeadsUp({
				env,
				callerContext,
				claimed: claimedExecuteUsage,
			})),
		]
		const runId =
			typeof result.runId === 'string'
				? result.runId
				: (claimedRunHandle?.id ?? undefined)
		// A generated key is not durable until the running row is confirmed.
		// In-budget responses already carry the module result, so they
		// include only a caller-supplied key. The transport-budget
		// follow response adds a generated key after that confirmation.
		const idempotencyKeyForResponse = runRowOwned
			? claimedRunHandle?.context.idempotencyKey?.trim() ||
				normalizedIdempotencyKey ||
				undefined
			: undefined
		const follow = {
			...(runId ? { runId } : {}),
			...(idempotencyKeyForResponse
				? { idempotencyKey: idempotencyKeyForResponse }
				: {}),
		}

		if (result.error) {
			const errorDetails = getExecutionErrorDetails(result.error, {
				orgSlug: callerContext.request?.org.slug,
			})
			const { errorName, errorMessage } = errorFields(result.error)
			logMcpEvent({
				category: 'mcp',
				tool: 'execute',
				toolName: 'execute',
				outcome: 'failure',
				durationMs,
				...mcpCallerFields,
				registeredCapabilityCount,
				sandboxError: true,
				errorName,
				errorMessage,
				cause: result.error,
			})
			return {
				content: prependToolMetadataContent(resolvedConversationId, [
					{
						type: 'text',
						text: formatExecutionOutput(result),
					},
					...ranOnContent,
					...formatRawFetchHostNudgeContent(rawFetchHostNudges),
					...formatSurfacedMemoriesMarkdown(surfacedMemories),
				]),
				structuredContent: {
					conversationId: resolvedConversationId,
					timing,
					...follow,
					returnedBytes: 0,
					error: errorMessage,
					errorDetails,
					...entitlementStructuredContent(result.error),
					logs: result.logs ?? [],
					...(rawFetchHostNudges.length > 0
						? { warnings: rawFetchHostNudges }
						: {}),
					...buildMemoryStructuredContent(surfacedMemories),
					...ranOnFields,
				},
				isError: true,
			}
		}

		logMcpEvent({
			category: 'mcp',
			tool: 'execute',
			toolName: 'execute',
			outcome: 'success',
			durationMs,
			...mcpCallerFields,
			registeredCapabilityCount,
			sandboxError: false,
			context: activeStorageId ? { storageId: activeStorageId } : undefined,
		})
		const responseLimitBytes =
			responseLimit ?? defaultExecutionResponseLimitBytes
		const passthrough = extractMcpPassthrough(result.result)
		const rawContent = passthrough?.content ?? null

		if (rawContent) {
			let validatedContent: Array<ContentBlock>
			try {
				validatedContent = validateDownstreamMcpContentBlocks(rawContent, {
					kind: 'execute',
					label: 'default export (__mcpContent)',
				})
			} catch (error) {
				const message = getErrorMessage(error)
				return {
					content: prependToolMetadataContent(resolvedConversationId, [
						{
							type: 'text',
							text: `Error: ${message}`,
						},
						...formatSurfacedMemoriesMarkdown(surfacedMemories),
						...ranOnContent,
					]),
					structuredContent: {
						conversationId: resolvedConversationId,
						timing,
						...follow,
						returnedBytes: 0,
						error: message,
						result: passthrough?.structuredResult ?? null,
						logs: result.logs ?? [],
						...buildMemoryStructuredContent(surfacedMemories),
						...ranOnFields,
					},
					isError: true,
				}
			}

			const contentLimited = limitMcpContentBlocks(
				validatedContent,
				defaultMcpContentLimitBytes,
			)
			if (!contentLimited.ok) {
				return {
					content: prependToolMetadataContent(resolvedConversationId, [
						{
							type: 'text',
							text: `Error: ${contentLimited.note}`,
						},
						...formatSurfacedMemoriesMarkdown(surfacedMemories),
						...ranOnContent,
					]),
					structuredContent: {
						conversationId: resolvedConversationId,
						timing,
						...follow,
						returnedBytes: contentLimited.returnedBytes,
						truncated: true,
						note: contentLimited.note,
						result: passthrough?.structuredResult ?? null,
						logs: result.logs ?? [],
						...buildMemoryStructuredContent(surfacedMemories),
						...ranOnFields,
					},
					isError: true,
				}
			}

			const companionLimited =
				passthrough?.structuredResult === undefined ||
				passthrough.structuredResult === null
					? null
					: limitExecutionResultValue(
							passthrough.structuredResult,
							responseLimitBytes,
						)
			const isError = passthrough?.isError ?? false
			const truncationNote =
				contentLimited.truncated && companionLimited?.truncated
					? `${contentLimited.note} ${companionLimited.note}`
					: contentLimited.truncated
						? contentLimited.note
						: companionLimited?.truncated
							? companionLimited.note
							: undefined
			if (!isError) {
				await scheduleFleetExecuteLastSuccess({
					waitUntil,
					kv: env.BUNDLE_ARTIFACTS_KV,
				})
			}

			return {
				content: prependToolMetadataContent(resolvedConversationId, [
					...contentLimited.blocks,
					...formatRawFetchHostNudgeContent(rawFetchHostNudges),
					...formatSurfacedMemoriesMarkdown(surfacedMemories),
					...ranOnContent,
				]),
				structuredContent: {
					conversationId: resolvedConversationId,
					timing,
					...follow,
					returnedBytes:
						contentLimited.returnedBytes +
						(companionLimited?.returnedBytes ?? 0),
					...(truncationNote
						? {
								truncated: true,
								note: truncationNote,
							}
						: {}),
					result: companionLimited
						? companionLimited.value
						: (passthrough?.structuredResult ?? null),
					logs: result.logs ?? [],
					...(rawFetchHostNudges.length > 0
						? { warnings: rawFetchHostNudges }
						: {}),
					...buildMemoryStructuredContent(surfacedMemories),
					...ranOnFields,
				},
				isError,
			}
		}

		const limitedResult = limitExecutionResultValue(
			result.result,
			responseLimitBytes,
		)
		const markerOnlyPassthrough =
			passthrough &&
			(passthrough.isError || passthrough.structuredResult !== null)
				? passthrough
				: null
		const structuredResultValue = markerOnlyPassthrough
			? limitExecutionResultValue(
					markerOnlyPassthrough.structuredResult ?? {},
					responseLimitBytes,
				)
			: limitedResult
		const isError = markerOnlyPassthrough?.isError ?? false
		if (!isError) {
			await scheduleFleetExecuteLastSuccess({
				waitUntil,
				kv: env.BUNDLE_ARTIFACTS_KV,
			})
		}

		return {
			content: prependToolMetadataContent(resolvedConversationId, [
				{
					type: 'text',
					text: formatLimitedExecutionOutput({
						value: structuredResultValue.value,
						truncated: structuredResultValue.truncated,
						note: structuredResultValue.note,
						displayText: structuredResultValue.displayText,
					}),
				},
				...ranOnContent,
				...formatRawFetchHostNudgeContent(rawFetchHostNudges),
				...formatSurfacedMemoriesMarkdown(surfacedMemories),
			]),
			structuredContent: {
				conversationId: resolvedConversationId,
				timing,
				...follow,
				returnedBytes: structuredResultValue.returnedBytes,
				...(structuredResultValue.truncated
					? {
							truncated: true,
							note: structuredResultValue.note,
						}
					: {}),
				result: structuredResultValue.value,
				logs: result.logs ?? [],
				...ranOnFields,
				...(rawFetchHostNudges.length > 0
					? { warnings: rawFetchHostNudges }
					: {}),
				...buildMemoryStructuredContent(surfacedMemories),
			},
			isError,
		}
	}
}

function normalizeExecuteIdempotencyKey(
	value: string | undefined,
): string | null {
	const trimmed = value?.trim()
	if (!trimmed) return null
	return trimmed.slice(0, runRecordMaxIdempotencyKeyLength)
}

/** The context a detached run is on; cloud runs have no context to cancel. */
function runningContextName(metadata: unknown) {
	if (!metadata || typeof metadata !== 'object') return null
	const { id, name } = metadata as { id?: unknown; name?: unknown }
	return typeof id === 'string' && id !== 'cloud' && typeof name === 'string'
		? name
		: null
}

function buildTransportBudgetFollowResponse(input: {
	conversationId: string
	timing: {
		startedAt: string
		endedAt: string
		durationMs: number
	}
	runId: string
	idempotencyKey: string
	memories: Parameters<typeof formatSurfacedMemoriesMarkdown>[0]
	executionContext?: unknown
}) {
	const { ranOnContent, ranOnFields } = ranOnParts(input.executionContext, {
		running: true,
	})
	const base = input.idempotencyKey
		? `Execute is still running (runId: ${input.runId}). Poll runGet with that id. Retrying execute with idempotencyKey "${input.idempotencyKey}" reads this run instead of starting another mutation.`
		: `Execute is still running (runId: ${input.runId}). Poll runGet with that id. Do not start another mutation for this call.`
	const contextName = runningContextName(input.executionContext)
	const text = contextName
		? `${base} To stop it, call executionContextRunCancel with id "${contextName}" and that run_id.`
		: base
	return {
		content: prependToolMetadataContent(input.conversationId, [
			{ type: 'text' as const, text },
			...ranOnContent,
			...formatSurfacedMemoriesMarkdown(input.memories),
		]),
		structuredContent: {
			conversationId: input.conversationId,
			timing: input.timing,
			runId: input.runId,
			...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
			inProgress: true as const,
			status: 'running' as const,
			...buildMemoryStructuredContent(input.memories),
			...ranOnFields,
		},
		isError: false,
	}
}

function buildKeyedExecuteLookupResponse(input: {
	run: RunRecord
	conversationId: string
	timing: {
		startedAt: string
		endedAt: string
		durationMs: number
	}
}) {
	if (input.run.status === 'running') {
		const running = ranOnParts(input.run.metadata['executionContext'], {
			running: true,
		})
		return {
			content: prependToolMetadataContent(input.conversationId, [
				{
					type: 'text',
					text: `Execute still in progress (runId: ${input.run.id}). Poll runGet with that id, or retry with the same idempotencyKey.`,
				},
				...running.ranOnContent,
			]),
			structuredContent: {
				conversationId: input.conversationId,
				timing: input.timing,
				runId: input.run.id,
				...(input.run.idempotencyKey
					? { idempotencyKey: input.run.idempotencyKey }
					: {}),
				inProgress: true,
				status: 'running' as const,
				...running.ranOnFields,
			},
			isError: false,
		}
	}

	const retainedResult = input.run.metadata['result']
	const { ranOnContent, ranOnFields } = ranOnParts(
		input.run.metadata['executionContext'],
	)
	if (input.run.status === 'error') {
		const errorMessage =
			input.run.errorMessage ?? 'Execute failed (replayed from run record).'
		const replayedError = new Error(errorMessage)
		if (input.run.errorName) replayedError.name = input.run.errorName
		return {
			content: prependToolMetadataContent(input.conversationId, [
				{
					type: 'text',
					text: `Error: ${errorMessage}`,
				},
				...ranOnContent,
			]),
			structuredContent: {
				conversationId: input.conversationId,
				timing: input.timing,
				runId: input.run.id,
				...(input.run.idempotencyKey
					? { idempotencyKey: input.run.idempotencyKey }
					: {}),
				replayed: true,
				returnedBytes: 0,
				error: errorMessage,
				...(input.run.errorName ? { errorName: input.run.errorName } : {}),
				...entitlementStructuredContent(replayedError),
				...(retainedResult !== undefined ? { result: retainedResult } : {}),
				logs: [] as Array<unknown>,
				...ranOnFields,
			},
			isError: true,
		}
	}

	return {
		content: prependToolMetadataContent(input.conversationId, [
			{
				type: 'text',
				text: formatLimitedExecutionOutput({
					value: retainedResult,
					truncated: false,
					note: undefined,
					displayText: undefined,
				}),
			},
			...ranOnContent,
		]),
		structuredContent: {
			conversationId: input.conversationId,
			timing: input.timing,
			runId: input.run.id,
			...(input.run.idempotencyKey
				? { idempotencyKey: input.run.idempotencyKey }
				: {}),
			replayed: true,
			returnedBytes: 0,
			result: retainedResult,
			logs: [] as Array<unknown>,
			...ranOnFields,
		},
		isError: false,
	}
}

function isRunMetadata(value: unknown): value is ExecutionContextRunMetadata {
	if (typeof value !== 'object' || value === null) return false
	return Array.isArray((value as Partial<ExecutionContextRunMetadata>).attempts)
}

/** `ranOn` (and the legacy `executionContext`) plus its human line. */
function ranOnParts(metadata: unknown, options: { running?: boolean } = {}) {
	const ranOn = ranOnFromMetadata(metadata)
	return {
		ranOnContent: [
			{ type: 'text' as const, text: describeRanOn(ranOn, options) },
		],
		ranOnFields: {
			ranOn,
			...(isRunMetadata(metadata) ? { executionContext: metadata } : {}),
		},
	}
}

function formatRawFetchHostNudgeContent(nudges: Array<string>) {
	if (nudges.length === 0) return []
	return [
		{
			type: 'text' as const,
			text: nudges.join('\n'),
		},
	]
}

function agentlessNudgeState(): McpRegistrationAgent {
	return {
		state: {},
		setState() {},
	} as unknown as McpRegistrationAgent
}

async function resolveRawFetchHostNudges(input: {
	agent: McpRegistrationAgent
	env: Env
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	conversationId: string
	hostCounts: ReadonlyMap<string, number>
	usedIntegrationAuthHelpers?: boolean
}): Promise<Array<string>> {
	if (input.hostCounts.size === 0) return []

	const statefulAgent = input.agent as McpRegistrationAgent & {
		state?: {
			rawFetchHostNudges?: RawFetchHostNudgeState
		}
		setState?: (state: {
			rawFetchHostNudges?: RawFetchHostNudgeState
			[key: string]: unknown
		}) => void
	}
	const applied = applyRawFetchHostCounts({
		state: statefulAgent.state?.rawFetchHostNudges,
		conversationId: input.conversationId,
		hostCounts: input.hostCounts,
		usedIntegrationAuthHelpers: input.usedIntegrationAuthHelpers,
	})
	if (typeof statefulAgent.setState === 'function') {
		statefulAgent.setState({
			...statefulAgent.state,
			rawFetchHostNudges: applied.state,
		})
	}
	return applied.nudges
}

/**
 * Once a month per org, the hosted execute call that mints a new worker
 * while the org is at or past 80% of its included Worker compute says so.
 */
async function resolveComputeIncludeHeadsUp(input: {
	env: Env
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	claimed: ClaimedExecuteUsage | null
}): Promise<Array<string>> {
	if (dailyFreshWorkersFromClaim(input.claimed?.usage) === null) return []
	const ownerId = ownerIdFromCaller(input.callerContext)
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!ownerId || !kv) return []
	try {
		const now = input.claimed?.claimedAt ?? new Date()
		const key = computeIncludeHeadsUpKvKey(ownerId, now)
		if (await kv.get(key)) return []
		const [entitlement, usage] = await Promise.all([
			getCachedUserEntitlement(input.env.APP_DB, {
				userId: ownerId,
				email: entitlementEmailForOwner(input.callerContext, ownerId),
			}),
			readMonthlyComputeUsage({
				db: input.env.APP_DB,
				stableUserId: ownerId,
				month: preferLocalNudgeMonthKey(now),
			}),
		])
		const slug = input.callerContext.request?.org.slug
		const usageUrl = new URL(
			slug ? orgUsagePath(slug) : '/account/usage',
			input.callerContext.baseUrl,
		).toString()
		const text = formatComputeIncludeHeadsUp({
			used: usage.uniqueWorkerDays,
			include: monthlyIncludeForPreferLocalNudge(entitlement, now),
			creditWallet: entitlement.creditWallet,
			usageUrl,
		})
		if (!text) return []
		await kv.put(key, String(now.getTime()), {
			expirationTtl: computeIncludeHeadsUpClaimTtlSeconds,
		})
		return [text]
	} catch (error: unknown) {
		console.warn('compute-include-heads-up-failed', error)
		return []
	}
}

async function resolvePreferLocalExecuteNudges(input: {
	agent: McpRegistrationAgent
	env: Env
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	conversationId: string
	claimed: ClaimedExecuteUsage | null
}): Promise<Array<string>> {
	if (isKnownWebOnlyMcpClient(input.callerContext.oauthClientId)) {
		return []
	}
	const dailyFreshWorkers = dailyFreshWorkersFromClaim(input.claimed?.usage)
	if (dailyFreshWorkers === null) return []

	const statefulAgent = input.agent as McpRegistrationAgent & {
		state?: {
			preferLocalExecuteNudgeConversationIds?: Array<string>
		}
		setState?: (state: {
			preferLocalExecuteNudgeConversationIds?: Array<string>
			[key: string]: unknown
		}) => void
	}
	const priorIds = statefulAgent.state?.preferLocalExecuteNudgeConversationIds
	if (
		Array.isArray(priorIds) &&
		priorIds.includes(input.conversationId.trim())
	) {
		return []
	}

	let monthlyUniqueWorkerDays: number | null = null
	let monthlyInclude: number | null = null
	const ownerId = ownerIdFromCaller(input.callerContext)
	if (
		ownerId &&
		!shouldTipPreferLocalExecuteNudge({
			dailyFreshWorkers,
			monthlyUniqueWorkerDays: null,
			monthlyInclude: null,
		})
	) {
		try {
			const now = input.claimed?.claimedAt ?? new Date()
			const entitlement = await getCachedUserEntitlement(input.env.APP_DB, {
				userId: ownerId,
				email: entitlementEmailForOwner(input.callerContext, ownerId),
			})
			const usage = await readMonthlyComputeUsage({
				db: input.env.APP_DB,
				stableUserId: ownerId,
				month: preferLocalNudgeMonthKey(now),
			})
			monthlyUniqueWorkerDays = usage.uniqueWorkerDays
			monthlyInclude = monthlyIncludeForPreferLocalNudge(entitlement, now)
		} catch (error: unknown) {
			console.warn('prefer-local-execute-nudge-monthly-read-failed', error)
		}
	}

	const shouldTip = shouldTipPreferLocalExecuteNudge({
		dailyFreshWorkers,
		monthlyUniqueWorkerDays,
		monthlyInclude,
	})
	const applied = applyPreferLocalExecuteNudge({
		state: {
			conversationIds: Array.isArray(priorIds) ? priorIds : [],
		},
		conversationId: input.conversationId,
		shouldTip,
	})
	if (typeof statefulAgent.setState === 'function' && shouldTip) {
		statefulAgent.setState({
			...statefulAgent.state,
			preferLocalExecuteNudgeConversationIds: applied.state.conversationIds,
		})
	}
	return applied.nudges
}
