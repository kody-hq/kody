import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { expect, onTestFinished, test, vi } from 'vitest'
import { planLimits } from '#universal/plans.ts'
import {
	BudgetLimitError,
	ComputeOverageLimitError,
	EntitlementLimitError,
	JobIntervalFloorError,
	buildEntitlementLimitMessage,
	buildEntitlementUpgradeHint,
	entitlementLimitErrorCode,
	jobIntervalFloorErrorCode,
} from '#worker/entitlements/errors.ts'
import {
	defaultMcpContentLimitBytes,
	maxMcpContentBlockCount,
	wrapDownstreamMcpToolResult,
} from '#mcp/downstream-mcp-result.ts'
import { formatRawFetchHostNudge } from '#mcp/raw-fetch-host-nudge.ts'
import {
	executeInvokeFlagOffMessage,
	executeInvokeMutualExclusionMessage,
} from '#mcp/execute-invoke.ts'
import type * as AccessControlModule from '#mcp/capabilities/access-control.ts'
import type * as MemoryToolContextModule from './memory-tool-context.ts'
import type * as CapabilityRegistryModule from '#mcp/capabilities/registry.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import {
	executeCallsPerMinutePerOrg,
	identicalExecuteCallsPerWindow,
	type ExecuteUsageReport,
} from '#mcp/execute-admission.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { runWithInboundRequestSignal } from '#mcp/inbound-request-signal.ts'
import type * as ExecuteTransportBudgetModule from '#mcp/execute-transport-budget.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'

const transportBudgetMock = vi.hoisted(() => ({
	remainingMs: null as number | null,
}))

const heartbeatMock = vi.hoisted(() => ({
	scheduleFleetExecuteLastSuccess: vi.fn(),
}))

vi.mock('#worker/execute-health-heartbeat.ts', () => heartbeatMock)

vi.mock('#mcp/execute-transport-budget.ts', async () => {
	const actual = await vi.importActual<typeof ExecuteTransportBudgetModule>(
		'#mcp/execute-transport-budget.ts',
	)
	return {
		...actual,
		remainingTransportBudgetMs: (
			input: Parameters<
				typeof ExecuteTransportBudgetModule.remainingTransportBudgetMs
			>[0],
		) =>
			transportBudgetMock.remainingMs === null
				? actual.remainingTransportBudgetMs(input)
				: transportBudgetMock.remainingMs,
	}
})

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	surfaceToolMemories: vi.fn(),
	createPackageEventTools: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(
		async (
			..._args: Parameters<
				typeof CapabilityRegistryModule.getCapabilityRegistryForContext
			>
		) => ({
			capabilityHandlers: {
				codingGuideGet: true,
			},
		}),
	),
	getRunRecordByIdempotencyKey: vi.fn<
		typeof RunRecordsServiceModule.getRunRecordByIdempotencyKey
	>(async () => null),
	getRunRecord: vi.fn<typeof RunRecordsServiceModule.getRunRecord>(
		async () => null,
	),
	beginRunRecord: vi.fn<typeof RunRecordsServiceModule.beginRunRecord>(
		() => null,
	),
	ensureRunRecordStarted: vi.fn<
		typeof RunRecordsServiceModule.ensureRunRecordStarted
	>(async () => true),
	claimRunRecord: vi.fn<typeof RunRecordsServiceModule.claimRunRecord>(
		async () => null,
	),
	finishRunRecord: vi.fn(
		async (
			..._args: Parameters<typeof RunRecordsServiceModule.finishRunRecord>
		) => undefined,
	),
	abandonRunRecord: vi.fn(
		async (
			..._args: Parameters<typeof RunRecordsServiceModule.abandonRunRecord>
		) => undefined,
	),
	resolveCallerFeatureFlags: vi.fn(
		async (
			..._args: Parameters<typeof AccessControlModule.resolveCallerFeatureFlags>
		) => ({
			'execute-invoke': false,
			'connection-profiles': false,
			'mcp-skills-extension': false,
			'mcp-events-extension': false,
		}),
	),
	callerFeatureFlagEvaluationFailed: vi.fn(
		async (
			..._args: Parameters<
				typeof AccessControlModule.callerFeatureFlagEvaluationFailed
			>
		) => false,
	),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

vi.mock('./memory-tool-context.ts', async () => {
	const actual = await vi.importActual<typeof MemoryToolContextModule>(
		'./memory-tool-context.ts',
	)
	mockModule.surfaceToolMemories.mockImplementation(actual.surfaceToolMemories)
	return {
		...actual,
		surfaceToolMemories: (
			...args: Parameters<typeof MemoryToolContextModule.surfaceToolMemories>
		) => mockModule.surfaceToolMemories(...args),
	}
})

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (
		...args: Parameters<
			typeof CapabilityRegistryModule.getCapabilityRegistryForContext
		>
	) => mockModule.getCapabilityRegistryForContext(...args),
}))

vi.mock(
	'#mcp/capabilities/access-control.ts',
	async (importOriginal: () => Promise<typeof AccessControlModule>) => {
		const actual = await importOriginal()
		return {
			...actual,
			resolveCallerFeatureFlags: (
				...args: Parameters<
					typeof AccessControlModule.resolveCallerFeatureFlags
				>
			) => mockModule.resolveCallerFeatureFlags(...args),
			callerFeatureFlagEvaluationFailed: (
				...args: Parameters<
					typeof AccessControlModule.callerFeatureFlagEvaluationFailed
				>
			) => mockModule.callerFeatureFlagEvaluationFailed(...args),
		}
	},
)

vi.mock('#worker/package-invocations/service.ts', () => ({
	createPackageEventTools: (...args: Array<unknown>) =>
		mockModule.createPackageEventTools(...args),
}))

vi.mock('#worker/run-records/service.ts', async () => {
	const actual = await vi.importActual<typeof RunRecordsServiceModule>(
		'#worker/run-records/service.ts',
	)
	return {
		...actual,
		getRunRecordByIdempotencyKey: (
			...args: Parameters<
				typeof RunRecordsServiceModule.getRunRecordByIdempotencyKey
			>
		) => mockModule.getRunRecordByIdempotencyKey(...args),
		getRunRecord: (
			...args: Parameters<typeof RunRecordsServiceModule.getRunRecord>
		) => mockModule.getRunRecord(...args),
		beginRunRecord: (
			...args: Parameters<typeof RunRecordsServiceModule.beginRunRecord>
		) => mockModule.beginRunRecord(...args),
		ensureRunRecordStarted: (
			...args: Parameters<typeof RunRecordsServiceModule.ensureRunRecordStarted>
		) => mockModule.ensureRunRecordStarted(...args),
		claimRunRecord: (
			...args: Parameters<typeof RunRecordsServiceModule.claimRunRecord>
		) => mockModule.claimRunRecord(...args),
		finishRunRecord: (
			...args: Parameters<typeof RunRecordsServiceModule.finishRunRecord>
		) => mockModule.finishRunRecord(...args),
		abandonRunRecord: (
			...args: Parameters<typeof RunRecordsServiceModule.abandonRunRecord>
		) => mockModule.abandonRunRecord(...args),
	}
})

const { registerExecuteTool } = await import('./execute.ts')

const userMeter = createInMemoryUserMeterEnv()

/**
 * Minimal env stub: UserMeter is in memory, and plan lookup never touches
 * D1 because these caller contexts carry no account email (resolves to
 * `max`).
 */
const stubEnv = {
	...userMeter.env,
	APP_DB: {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							return null
						},
						async all() {
							return { results: [] }
						},
					}
				},
			}
		},
	},
}

const mockPerformanceNow = vi.spyOn(performance, 'now')

function mockPerformanceSequence(...values: Array<number>) {
	let index = 0
	mockPerformanceNow.mockImplementation(() => {
		const value = values[Math.min(index, values.length - 1)] ?? 0
		index += 1
		return value
	})
}

type ExecuteInput = {
	code?: string
	invoke?: string
	params?: Record<string, unknown>
	responseLimit?: number
	conversationId?: string
	idempotencyKey?: string
	memoryContext?: { task?: string; query?: string }
}

type ExecuteResponse = {
	content: Array<ContentBlock>
	structuredContent: {
		conversationId: string
		runId?: string
		idempotencyKey?: string
		replayed?: boolean
		inProgress?: boolean
		status?: string
		returnedBytes: number
		truncated?: boolean
		note?: string
		warnings?: Array<string>
		timing: {
			startedAt: string
			endedAt: string
			durationMs: number
		}
		result: unknown
		logs: Array<unknown>
		error?: string
		errorDetails?: unknown
		entitlement?: {
			code: string
			resource: string
			plan: string
			limit?: number
			current?: number
			upgradeHint: string
			used?: number
			remaining?: number
		}
		usage?: ExecuteUsageReport
	}
	isError: boolean
}

type ExecuteHandler = (
	input: ExecuteInput,
	extra?: {
		mcpReq?: {
			_meta?: { progressToken?: string }
			notify?: (notification: unknown) => Promise<void>
		}
	},
) => Promise<ExecuteResponse>

type CallerContext = {
	baseUrl: string
	user: null | {
		userId: string
		email?: string
		displayName?: string
	}
}

async function getExecuteRegistration(
	callerContext: CallerContext = { baseUrl: 'https://example.com', user: null },
	agentExtras: {
		state?: Record<string, unknown>
		setState?: (state: Record<string, unknown>) => void
		waitUntil?: (promise: Promise<unknown>) => void
		invokeEnabled?: boolean
	} = {},
) {
	vi.clearAllMocks()
	mockModule.resolveCallerFeatureFlags.mockResolvedValue({
		'execute-invoke': agentExtras.invokeEnabled === true,
		'connection-profiles': false,
		'mcp-skills-extension': false,
		'mcp-events-extension': false,
	})
	mockModule.callerFeatureFlagEvaluationFailed.mockResolvedValue(false)
	const registerTool = vi.fn()

	await registerExecuteTool({
		server: { registerTool } as never,
		getEnv: vi.fn(() => stubEnv),
		getCallerContext: vi.fn(() => callerContext),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
		...agentExtras,
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	return registerTool.mock.calls[0] as [
		string,
		{ description: string; inputSchema: Record<string, unknown> },
		ExecuteHandler,
	]
}

async function getExecuteHandler(
	...args: Parameters<typeof getExecuteRegistration>
) {
	const [, , handler] = await getExecuteRegistration(...args)
	return handler
}

function moduleReturns(result: unknown, extra: Record<string, unknown> = {}) {
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({
		result,
		logs: [],
		...extra,
	})
}

function moduleThrows(error: Error, logs: Array<unknown> = []) {
	mockModule.runModuleWithRegistry.mockResolvedValueOnce({ error, logs })
}

const okCode = 'export default async () => ({ ok: true })'
const shouldNotRunCode = 'export default async () => ({ shouldNotRun: true })'
const timing = (durationMs: number) => ({
	startedAt: expect.any(String),
	endedAt: expect.any(String),
	durationMs,
})
const truncationNote = (bytes: number, limit: number) =>
	`Returned value was ${String(bytes)} bytes, exceeding responseLimit ${String(limit)} bytes; output was truncated. Project fields before returning.`

test('execute tool serializes successes and errors, binds no packages helper tools, and truncates oversized returns', async () => {
	const handler = await getExecuteHandler()
	const rawContent: Array<ContentBlock> = [
		{
			type: 'image',
			data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
			mimeType: 'image/png',
		},
		{ type: 'text', text: 'Screenshot of https://example.com' },
	]
	mockPerformanceSequence(100, 142)
	moduleReturns(
		{ __mcpContent: rawContent },
		{ logs: [{ level: 'info', message: 'captured screenshot' }] },
	)

	const mcpContentResponse = await handler({
		code: 'async () => ({ __mcpContent: [] })',
		conversationId: 'conv-123',
	})

	expect(mockModule.getCapabilityRegistryForContext).toHaveBeenCalledTimes(1)
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		'async () => ({ __mcpContent: [] })',
		undefined,
		expect.objectContaining({
			capabilityRegistry: { capabilityHandlers: { codingGuideGet: true } },
		}),
	)
	expect(mcpContentResponse.isError).toBe(false)
	expect(mcpContentResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-123' },
		...rawContent,
	])
	expect(mcpContentResponse.structuredContent).toEqual({
		conversationId: 'conv-123',
		timing: timing(42),
		returnedBytes: new TextEncoder().encode(JSON.stringify(rawContent))
			.byteLength,
		result: null,
		logs: [{ level: 'info', message: 'captured screenshot' }],
	})

	const serverTiming = [
		{ name: 'typecheck-total', durationMs: 12 },
		{ name: 'bundle', durationMs: 34 },
		{ name: 'run', durationMs: 56 },
	]
	mockPerformanceSequence(10, 19)
	moduleReturns({ ok: true }, { serverTiming })
	const jsonResponse = await handler({
		code: 'async () => ({ ok: true })',
		conversationId: 'conv-456',
	})
	expect(jsonResponse.isError).toBe(false)
	expect(jsonResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-456' },
		{ type: 'text', text: '{\n  "ok": true\n}' },
	])
	expect(jsonResponse.structuredContent).toEqual({
		conversationId: 'conv-456',
		timing: { ...timing(9), serverTiming },
		returnedBytes: 11,
		result: { ok: true },
		logs: [],
	})

	const callerContext = {
		baseUrl: 'https://example.com',
		user: {
			userId: ownerIdFromStored('user-123'),
			email: 'me@example.com',
			displayName: 'Me',
		},
	}
	const authenticatedHandler = await getExecuteHandler(callerContext)
	moduleReturns({ ok: true })
	await authenticatedHandler({ code: okCode, conversationId: 'conv-packages' })
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining(callerContext),
		okCode,
		undefined,
		expect.objectContaining({
			conversationId: 'conv-packages',
			runRecordHandle: null,
			runRecord: {
				surface: 'execute',
				name: null,
				storageId: null,
				idempotencyKey: null,
				metadata: { conversationId: 'conv-packages', entry: 'code' },
			},
		}),
	)
	expect(
		mockModule.runModuleWithRegistry.mock.lastCall?.[4],
	).not.toHaveProperty('packageInvokeTools')

	mockPerformanceSequence(20, 25)
	moduleReturns('hello world')
	const truncatedStringResponse = await handler({
		code: 'async () => "hello world"',
		responseLimit: 5,
		conversationId: 'conv-truncated-string',
	})
	expect(truncatedStringResponse.isError).toBe(false)
	expect(truncatedStringResponse.content).toEqual([
		{ type: 'text', text: 'conversationId: conv-truncated-string' },
		{
			type: 'text',
			text: `hello\n\n--- TRUNCATED ---\n${truncationNote(11, 5)}`,
		},
	])
	expect(truncatedStringResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-string',
		timing: timing(5),
		returnedBytes: 11,
		truncated: true,
		note: truncationNote(11, 5),
		result: 'hello',
		logs: [],
	})

	mockPerformanceSequence(30, 40)
	moduleReturns({ rows: [{ id: 'message-1', payload: 'abcdef' }] })
	const truncatedObjectResponse = await handler({
		code: 'async () => ({ rows: [{ id: "message-1", payload: "abcdef" }] })',
		responseLimit: 10,
		conversationId: 'conv-truncated-object',
	})
	expect(truncatedObjectResponse.isError).toBe(false)
	expect(truncatedObjectResponse.content[1]).toEqual({
		type: 'text',
		text: `{\n  "truncated": true,\n  "type": "object"\n}\n\n--- TRUNCATED ---\n${truncationNote(48, 10)}`,
	})
	expect(truncatedObjectResponse.structuredContent).toEqual({
		conversationId: 'conv-truncated-object',
		timing: timing(10),
		returnedBytes: 48,
		truncated: true,
		note: truncationNote(48, 10),
		result: { truncated: true, type: 'object' },
		logs: [],
	})

	mockPerformanceSequence(50, 65)
	moduleThrows(new Error('Boom'), [{ level: 'error', message: 'failed' }])
	const errorResponse = await handler({
		code: 'async () => { throw new Error("Boom") }',
		conversationId: 'conv-error',
	})
	expect(errorResponse.isError).toBe(true)
	expect(errorResponse.structuredContent).toEqual(
		expect.objectContaining({
			conversationId: 'conv-error',
			timing: timing(15),
			error: 'Boom',
			returnedBytes: 0,
			logs: [{ level: 'error', message: 'failed' }],
		}),
	)
})

test('execute passes through downstream MCP image content with structured data and rejects oversize content explicitly', async () => {
	const handler = await getExecuteHandler()
	const webpBlock = {
		type: 'image' as const,
		data: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=',
		mimeType: 'image/webp',
	}
	const conversationLine = (conversationId: string) => ({
		type: 'text',
		text: `conversationId: ${conversationId}`,
	})

	moduleReturns(
		wrapDownstreamMcpToolResult(
			{ content: [webpBlock], structuredContent: { shotId: 's1' } },
			{ kind: 'mcp-server', label: 'vision:screenshot' },
		),
	)
	const passthroughResponse = await handler({
		code: 'async () => downstream',
		conversationId: 'conv-passthrough',
	})
	expect(passthroughResponse.isError).toBe(false)
	expect(passthroughResponse.content).toEqual([
		conversationLine('conv-passthrough'),
		webpBlock,
	])
	expect(passthroughResponse.structuredContent.result).toEqual({
		shotId: 's1',
	})

	const largeBlock = {
		type: 'image' as const,
		data: 'A'.repeat(Math.ceil(110_000 / 4) * 4),
		mimeType: 'image/webp',
	}
	moduleReturns({ __mcpContent: [largeBlock] })
	const largeResponse = await handler({
		code: 'async () => large',
		conversationId: 'conv-large-image',
		responseLimit: 102_400,
	})
	expect(largeResponse.isError).toBe(false)
	expect(largeResponse.content).toEqual([
		conversationLine('conv-large-image'),
		largeBlock,
	])

	moduleReturns({
		__mcpContent: [
			{
				type: 'image',
				data: 'A'.repeat(
					Math.ceil((defaultMcpContentLimitBytes + 50_000) / 4) * 4,
				),
				mimeType: 'image/png',
			},
		],
	})
	const oversizeResponse = await handler({
		code: 'async () => oversize',
		conversationId: 'conv-oversize',
	})
	expect(oversizeResponse.isError).toBe(true)
	expect(oversizeResponse.structuredContent.error).toContain(
		'exceeding content limit',
	)
	expect(oversizeResponse.content[1]).toMatchObject({
		type: 'text',
		text: expect.stringContaining('exceeding content limit'),
	})

	// Oversized text-only __mcpContent truncates (usable result) instead of failing.
	const hugeText = 'T'.repeat(defaultMcpContentLimitBytes + 80_000)
	moduleReturns({
		__mcpContent: [{ type: 'text', text: hugeText }],
	})
	const oversizeTextResponse = await handler({
		code: 'async () => oversize-text',
		conversationId: 'conv-oversize-text',
	})
	expect(oversizeTextResponse.isError).toBe(false)
	expect(oversizeTextResponse.structuredContent.truncated).toBe(true)
	expect(oversizeTextResponse.structuredContent.note).toMatch(
		/text was truncated/,
	)
	const returnedText = oversizeTextResponse.content
		.filter((block) => block.type === 'text')
		.map((block) => (block.type === 'text' ? block.text : ''))
		.join('')
	expect(returnedText).toContain('--- TRUNCATED ---')
	expect(returnedText.length).toBeLessThan(hugeText.length)

	// Ordinary application objects with a `content` array stay JSON text.
	moduleReturns({ content: [webpBlock], ok: true })
	const arbitraryContentResponse = await handler({
		code: 'async () => ({ content: [...] })',
		conversationId: 'conv-arbitrary-content',
	})
	expect(arbitraryContentResponse.isError).toBe(false)
	expect(arbitraryContentResponse.content).toEqual([
		conversationLine('conv-arbitrary-content'),
		{
			type: 'text',
			text: JSON.stringify({ content: [webpBlock], ok: true }, null, 2),
		},
	])

	// Malformed user-authored __mcpContent becomes an isError result (no throw).
	moduleReturns({
		__mcpContent: [{ type: 'image', data: '!!!', mimeType: 'image/png' }],
	})
	const malformedResponse = await handler({
		code: 'async () => bad',
		conversationId: 'conv-malformed',
	})
	expect(malformedResponse.isError).toBe(true)
	expect(malformedResponse.structuredContent.error).toMatch(
		/default export \(__mcpContent\)[\s\S]*malformed MCP content/,
	)
	expect(malformedResponse.content.some((b) => b.type === 'image')).toBe(false)

	// Too many content blocks fail before expensive validation work.
	moduleReturns({
		__mcpContent: Array.from({ length: maxMcpContentBlockCount + 1 }, () => ({
			type: 'text',
			text: 'x',
		})),
	})
	const tooManyBlocksResponse = await handler({
		code: 'async () => many',
		conversationId: 'conv-too-many-blocks',
	})
	expect(tooManyBlocksResponse.isError).toBe(true)
	expect(tooManyBlocksResponse.structuredContent.error).toContain(
		'too many MCP content blocks',
	)
})

test('execute tool nudges repeated raw-fetch hosts once per conversation', async () => {
	const agentState: Record<string, unknown> = {}
	const setState = vi.fn((next: Record<string, unknown>) => {
		for (const key of Object.keys(agentState)) {
			delete agentState[key]
		}
		Object.assign(agentState, next)
	})
	const handler = await getExecuteHandler(
		{
			baseUrl: 'https://example.com',
			user: { userId: ownerIdFromStored('user-1'), email: 'user@example.com' },
		},
		{ state: agentState, setState },
	)
	const rawFetches =
		(hostname: string, count: number) =>
		async (
			_env: unknown,
			_ctx: unknown,
			_code: string,
			_params: unknown,
			options: { rawFetchHostSink?: { add: (hostname: string) => void } },
		) => {
			for (let i = 0; i < count; i++) {
				options.rawFetchHostSink?.add(hostname)
			}
			return { result: { ok: true }, logs: [] }
		}

	mockModule.runModuleWithRegistry.mockImplementation(
		rawFetches('api.notion.com', 2),
	)
	const warningsFor = async (conversationId: string, code = okCode) =>
		(await handler({ code, conversationId })).structuredContent.warnings
	expect(await warningsFor('conv-nudge')).toBeUndefined()
	const tipped = await warningsFor('conv-nudge')
	expect(tipped).toEqual([
		formatRawFetchHostNudge({ hostname: 'api.notion.com', count: 4 }),
	])
	expect(setState).toHaveBeenCalled()
	expect(await warningsFor('conv-nudge')).toBeUndefined()

	// Integration-auth helper source sharpens the packages-first warning text.
	mockModule.runModuleWithRegistry.mockImplementationOnce(
		rawFetches('gmail.googleapis.com', 3),
	)
	const authHelperTipped = await warningsFor(
		'conv-oauth-nudge',
		`import { createAuthenticatedFetch } from 'kody:runtime'
export default async () => ({ ok: true })`,
	)
	expect(authHelperTipped).toEqual([
		formatRawFetchHostNudge({
			hostname: 'gmail.googleapis.com',
			count: 3,
			usedIntegrationAuthHelpers: true,
		}),
	])
	expect(authHelperTipped?.[0]).not.toBe(tipped?.[0])
})

test('execute tool replays finished keyed runs and reports in-progress without re-executing', async () => {
	const finishedRun = {
		id: 'run-finished-1',
		surface: 'execute' as const,
		status: 'success' as const,
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: 'spawn-agent-1',
		parentRunId: null,
		startedAt: '2026-07-28T00:00:00.000Z',
		finishedAt: '2026-07-28T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		metadata: { result: { ok: true, agentId: 'agent-9' } },
		logCount: 0,
	}
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: {
			userId: ownerIdFromStored('user-keyed-execute'),
			email: 'keyed@example.com',
			displayName: 'Keyed',
		},
	})
	const replay = async (
		conversationId: string,
		record: Record<string, unknown> = {},
	) => {
		mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce({
			...finishedRun,
			...record,
		} as never)
		const response = await handler({
			code: shouldNotRunCode,
			idempotencyKey: 'spawn-agent-1',
			conversationId,
		})
		expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
		return response
	}

	const replayed = await replay('conv-replay')
	expect(replayed.isError).toBe(false)
	expect(replayed.structuredContent).toMatchObject({
		runId: 'run-finished-1',
		replayed: true,
		result: { ok: true, agentId: 'agent-9' },
	})

	const inProgress = await replay('conv-running', {
		id: 'run-running-1',
		status: 'running',
		finishedAt: null,
		durationMs: null,
		metadata: {},
	})
	expect(inProgress.isError).toBe(false)
	expect(inProgress.structuredContent).toMatchObject({
		runId: 'run-running-1',
		inProgress: true,
		status: 'running',
	})

	const quotaLimit = planLimits.free.maxExecuteUniqueWorkersPerDay
	const quotaHint = buildEntitlementUpgradeHint({
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
	})
	const quotaMessage = buildEntitlementLimitMessage({
		code: entitlementLimitErrorCode,
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
	})
	const quotaReplayed = await replay('conv-quota-replay', {
		id: 'run-quota-replay-1',
		status: 'error',
		errorName: 'EntitlementLimitError',
		errorMessage: quotaMessage,
		metadata: {},
	})
	expect(quotaReplayed.isError).toBe(true)
	expect(quotaReplayed.structuredContent.error).toBe(quotaMessage)
	expect(quotaReplayed.structuredContent.entitlement).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
		used: quotaLimit,
		remaining: 0,
	})

	const intervalDenial = new JobIntervalFloorError({
		plan: 'free',
		minIntervalMs: planLimits.free.minJobIntervalMs,
	})
	const intervalReplayed = await replay('conv-interval-replay', {
		id: 'run-interval-replay-1',
		status: 'error',
		errorName: 'JobIntervalFloorError',
		errorMessage: intervalDenial.message,
		metadata: {},
	})
	expect(intervalReplayed.isError).toBe(true)
	expect(intervalReplayed.structuredContent.error).toBe(intervalDenial.message)
	expect(intervalReplayed.structuredContent.entitlement).toEqual({
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		upgradeHint: intervalDenial.details.upgradeHint,
		minIntervalMs: planLimits.free.minJobIntervalMs,
	})
})

test('execute tool claims a keyed run, passes the handle, and returns runId', async () => {
	const claimedHandle = {
		id: 'run-claimed-1',
		userId: ownerIdFromStored('user-claim-execute'),
		startedAt: '2026-07-28T00:00:00.000Z',
		persistence: 'eager' as const,
		context: { surface: 'execute' as const, idempotencyKey: 'claim-key-1' },
	}
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: {
			userId: ownerIdFromStored('user-claim-execute'),
			email: 'claim@example.com',
			displayName: 'Claim',
		},
	})
	mockModule.getRunRecordByIdempotencyKey.mockResolvedValueOnce(null)
	mockModule.claimRunRecord.mockResolvedValueOnce({
		claimed: true,
		handle: claimedHandle,
	} as never)
	moduleReturns({ spawned: true }, { runId: 'run-claimed-1' })
	const code = 'export default async () => ({ spawned: true })'
	const response = await handler({
		code,
		idempotencyKey: 'claim-key-1',
		conversationId: 'conv-claim',
	})
	expect(mockModule.claimRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-claim-execute'),
			context: expect.objectContaining({
				surface: 'execute',
				idempotencyKey: 'claim-key-1',
			}),
		}),
	)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		code,
		undefined,
		expect.objectContaining({
			runRecordHandle: claimedHandle,
			runRecord: expect.objectContaining({ idempotencyKey: 'claim-key-1' }),
		}),
	)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-claimed-1',
		result: { spawned: true },
	})
})

test('execute tool releases a keyed claim when a usage denial stops the load', async () => {
	const denials = [
		new EntitlementLimitError({
			resource: 'execute_unique_workers_per_day',
			plan: 'free',
			limit: 150,
			current: 150,
			upgradeHint: buildEntitlementUpgradeHint({
				resource: 'execute_unique_workers_per_day',
				plan: 'free',
			}),
		}),
		new ComputeOverageLimitError({
			resource: 'unique_worker_days',
			plan: 'pro',
			limit: 350,
			current: 351,
			creditsStatus: 'add_credits',
		}),
		new BudgetLimitError({
			kind: 'user',
			orgSlug: 'acme',
			actorUsername: 'sam',
			spentMicroUsd: 50_000_000,
			budgetMicroUsd: 50_000_000,
		}),
	]
	for (const denial of denials) {
		const claimedHandle = {
			id: `run-claimed-${denial.name}`,
			userId: ownerIdFromStored('user-claim-denied'),
			startedAt: '2026-07-28T00:00:00.000Z',
			persistence: 'eager' as const,
			context: { surface: 'execute' as const, idempotencyKey: 'claim-denied' },
		}
		const handler = await getExecuteHandler({
			baseUrl: 'https://example.com',
			user: {
				userId: ownerIdFromStored('user-claim-denied'),
				email: 'claim-denied@example.com',
			},
		})
		mockModule.claimRunRecord.mockResolvedValueOnce({
			claimed: true,
			handle: claimedHandle,
		} as never)
		mockModule.runModuleWithRegistry.mockRejectedValueOnce(denial)
		mockModule.finishRunRecord.mockClear()
		const response = await handler({
			code: okCode,
			idempotencyKey: 'claim-denied',
			conversationId: 'conv-claim-denied',
		})
		expect(response.isError).toBe(true)
		expect(response.structuredContent.error).toBe(denial.message)
		expect(Boolean(response.structuredContent.entitlement)).toBe(
			!(denial instanceof BudgetLimitError),
		)
		expect(mockModule.abandonRunRecord).toHaveBeenCalledWith(
			expect.objectContaining({ handle: claimedHandle }),
		)
		expect(mockModule.finishRunRecord).not.toHaveBeenCalled()
	}
})

test('execute tool threads a progress reporter when the client sends progressToken', async () => {
	const handler = await getExecuteHandler()
	moduleReturns({ ok: true })
	const notify = vi.fn().mockResolvedValue(undefined)
	await handler(
		{ code: okCode },
		{ mcpReq: { _meta: { progressToken: 'progress-1' }, notify } },
	)
	expect(mockModule.runModuleWithRegistry).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		okCode,
		undefined,
		expect.objectContaining({ reportProgress: expect.any(Function) }),
	)
	const options = mockModule.runModuleWithRegistry.mock.calls.at(-1)?.[4] as {
		reportProgress?: (update: {
			progress: number
			message?: string
		}) => Promise<void>
	}
	await options.reportProgress?.({ progress: 1, message: 'bundle time' })
	expect(notify).toHaveBeenCalledWith({
		method: 'notifications/progress',
		params: {
			progressToken: 'progress-1',
			progress: 1,
			message: 'bundle time',
		},
	})
})

test('execute tool attaches entitlement metadata on denials and quota, not on success, and heartbeats only on success', async () => {
	const handler = await getExecuteHandler()
	mockPerformanceSequence(1, 2)
	moduleReturns({ ok: true })
	const success = await handler({
		code: okCode,
		conversationId: 'conv-entitlement-success',
	})
	expect(success.isError).toBe(false)
	expect(success.structuredContent).toEqual({
		conversationId: 'conv-entitlement-success',
		timing: timing(1),
		returnedBytes: expect.any(Number),
		result: { ok: true },
		logs: [],
	})
	expect(success.structuredContent).not.toHaveProperty('entitlement')
	expect(heartbeatMock.scheduleFleetExecuteLastSuccess).toHaveBeenCalledTimes(1)

	heartbeatMock.scheduleFleetExecuteLastSuccess.mockClear()
	const stockLimit = planLimits.free.maxSavedPackages
	const stockHint = buildEntitlementUpgradeHint({
		resource: 'saved_packages',
		plan: 'free',
	})
	const stockDenial = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: stockHint,
	})
	moduleThrows(stockDenial)
	const denied = await handler({
		code: 'export default async () => { throw stockDenial }',
		conversationId: 'conv-entitlement-stock',
	})
	expect(denied.isError).toBe(true)
	expect(denied.structuredContent.error).toBe(stockDenial.message)
	expect(denied.structuredContent.entitlement).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: stockHint,
	})
	expect(denied.structuredContent.entitlement).not.toHaveProperty('used')
	expect(denied.structuredContent.entitlement).not.toHaveProperty('remaining')

	moduleThrows(new Error('caller boom'))
	const failure = await handler({
		code: 'export default async () => { throw new Error("caller boom") }',
		conversationId: 'conv-heartbeat-error',
	})
	expect(failure.isError).toBe(true)
	expect(failure.structuredContent).not.toHaveProperty('entitlement')
	expect(heartbeatMock.scheduleFleetExecuteLastSuccess).not.toHaveBeenCalled()

	const quotaEmail = 'quota-metadata@example.com'
	const quotaUserId = testStableUserIdFromEmail(quotaEmail)
	const quotaLimit = planLimits.free.maxExecuteUniqueWorkersPerDay
	await userMeter.seed({
		userId: quotaUserId,
		resource: 'execute_unique_workers_per_day',
		day: utcDayKey(new Date()),
		count: quotaLimit - 1,
	})
	const quotaHandler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: { userId: quotaUserId, email: quotaEmail },
	})
	const sandboxLoads: Array<string> = []
	function runWorker(workerId: string) {
		mockModule.runModuleWithRegistry.mockImplementationOnce(
			async (...args: Array<unknown>) => {
				const options = args[4] as {
					claimWorkerDay?: (id: string) => Promise<{ created: boolean }>
				}
				await options.claimWorkerDay?.(workerId)
				sandboxLoads.push(workerId)
				return { result: { ok: workerId }, logs: [] }
			},
		)
	}
	runWorker('kody-worker-a')
	const lastUnit = await quotaHandler({
		code: okCode,
		conversationId: 'conv-entitlement-quota',
	})
	expect(lastUnit.isError).toBe(false)
	const quotaWeekLimit = planLimits.free.maxExecuteUniqueWorkersPerWeek!
	const atLimitUsage = {
		unit: 'unique execute workers',
		day: {
			used: quotaLimit,
			limit: quotaLimit,
			remaining: 0,
			resetsAt: expect.stringMatching(/T00:00:00\.000Z$/),
		},
		week: {
			used: quotaLimit,
			limit: quotaWeekLimit,
			remaining: quotaWeekLimit - quotaLimit,
			resetsAt: expect.stringMatching(/T00:00:00\.000Z$/),
		},
	}
	expect(lastUnit.structuredContent.usage).toEqual(atLimitUsage)
	runWorker('kody-worker-a')
	const repeatAtLimit = await quotaHandler({
		code: okCode,
		params: { other: true },
		conversationId: 'conv-entitlement-quota',
	})
	expect(repeatAtLimit.isError).toBe(false)
	expect(repeatAtLimit.structuredContent.usage).toEqual(atLimitUsage)
	runWorker('kody-worker-b')
	const quotaDenied = await quotaHandler({
		code: shouldNotRunCode,
		conversationId: 'conv-entitlement-quota',
	})
	expect(sandboxLoads).toEqual(['kody-worker-a', 'kody-worker-a'])
	expect(quotaDenied.isError).toBe(true)
	expect(quotaDenied.structuredContent.usage).toEqual(atLimitUsage)
	const quotaHint = quotaDenied.structuredContent.entitlement?.upgradeHint
	if (quotaHint === undefined) {
		throw new Error('Expected an entitlement upgrade hint on quota denial')
	}
	expect(quotaHint).toMatch(
		/^This daily limit resets at 00:00 UTC, in (\d+d )?(\d+h )?\d+m\. Rerun code you already ran today and vary params; repeats are free, or upgrade your plan at \/@[^/]+\/-\/billing\.$/,
	)
	const quotaEntitlement = {
		code: entitlementLimitErrorCode,
		resource: 'execute_unique_workers_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
	} as const
	expect(quotaDenied.structuredContent.error).toBe(
		buildEntitlementLimitMessage(quotaEntitlement),
	)
	expect(quotaDenied.structuredContent.entitlement).toEqual({
		...quotaEntitlement,
		used: quotaLimit,
		remaining: 0,
	})
})

test('execute tool refuses past the per-minute runaway limit before any run work', async () => {
	const email = 'execute-rate@example.com'
	const userId = testStableUserIdFromEmail(email)
	const meter = userMeterRpc({
		env: userMeter.env,
		userId: ownerIdFromStored(userId),
	})
	const nowMs = Date.parse('2026-10-10T12:00:10.000Z')
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(nowMs)
	onTestFinished(() => {
		vi.useRealTimers()
	})
	for (let index = 0; index < executeCallsPerMinutePerOrg; index += 1) {
		await meter.admitExecuteCall({
			nowMs,
			limitPerMinute: executeCallsPerMinutePerOrg,
		})
	}
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: { userId, email },
	})
	mockModule.surfaceToolMemories.mockClear()
	const refused = await handler({
		code: shouldNotRunCode,
		conversationId: 'conv-execute-rate',
		memoryContext: { task: 'recall what the user asked for last time' },
	})
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	// Memory retrievers can run package code, so a refused call never starts
	// them.
	expect(mockModule.surfaceToolMemories).not.toHaveBeenCalled()
	expect(refused.isError).toBe(true)
	expect(refused.structuredContent.error).toMatch(
		new RegExp(
			`^Execute rate limit: this account started ${executeCallsPerMinutePerOrg} execute calls in the last minute`,
		),
	)
	expect(refused.structuredContent).toMatchObject({
		admission: { code: 'execute_rate_limited' },
	})
})

test('execute tool refuses an identical call loop but still runs changed params', async () => {
	const email = 'execute-loop@example.com'
	const userId = testStableUserIdFromEmail(email)
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(Date.parse('2026-10-10T12:00:10.000Z'))
	onTestFinished(() => {
		vi.useRealTimers()
	})
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: { userId, email },
	})
	const call = (params: Record<string, unknown>) =>
		handler({ code: okCode, params, conversationId: 'conv-execute-loop' })
	mockModule.runModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
	for (let index = 0; index < identicalExecuteCallsPerWindow; index += 1) {
		expect((await call({ id: 1 })).isError).toBeFalsy()
	}
	const refused = await call({ id: 1 })
	expect(refused.isError).toBe(true)
	expect(refused.structuredContent.error).toMatch(
		`Execute loop detected: this connection ran the same code with the same params ${identicalExecuteCallsPerWindow} times in the last 60s.`,
	)
	expect(refused.structuredContent).toMatchObject({
		admission: {
			code: 'execute_loop_detected',
			retryAfterMs: expect.any(Number),
		},
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledTimes(
		identicalExecuteCallsPerWindow,
	)
	expect((await call({ id: 2 })).isError).toBeFalsy()
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledTimes(
		identicalExecuteCallsPerWindow + 1,
	)
})

test('execute invoke is omitted when the flag is off and mints the handwritten passthrough when on', async () => {
	const [offName, offConfig, offHandler] = await getExecuteRegistration()
	expect(offName).toBe('execute')
	expect(offConfig.inputSchema).not.toHaveProperty('invoke')

	const rejected = await offHandler({
		invoke: 'kody:@acme/github/listRepos',
		conversationId: 'conv-invoke-off',
	})
	expect(rejected.isError).toBe(true)
	expect(rejected.structuredContent.error).toBe(executeInvokeFlagOffMessage)
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()

	const [, onConfig, onHandler] = await getExecuteRegistration(
		{
			baseUrl: 'https://example.com',
			user: { userId: ownerIdFromStored('user-1') },
		},
		{ invokeEnabled: true },
	)
	expect(onConfig.inputSchema).toHaveProperty('invoke')

	moduleReturns({ ok: true })
	const invoked = await onHandler({
		invoke: '@acme/github#listRepos',
		params: { limit: 5 },
		conversationId: 'conv-invoke-on',
	})
	expect(invoked.isError).toBe(false)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		`import action from "kody:@acme/github/listRepos"

export default async function main(params) {
	return await action(params)
}`,
		{ limit: 5 },
		expect.objectContaining({
			runRecord: expect.objectContaining({
				metadata: {
					conversationId: 'conv-invoke-on',
					entry: 'invoke',
					invoke: 'kody:@acme/github/listRepos',
				},
			}),
		}),
	)

	const both = await onHandler({
		code: 'export default async function main() { return 1 }',
		invoke: 'kody:@acme/github/listRepos',
		conversationId: 'conv-invoke-both',
	})
	expect(both.isError).toBe(true)
	expect(both.structuredContent.error).toBe(executeInvokeMutualExclusionMessage)

	mockModule.resolveCallerFeatureFlags.mockResolvedValue({
		'execute-invoke': false,
		'connection-profiles': false,
		'mcp-skills-extension': false,
		'mcp-events-extension': false,
	})
	const killed = await onHandler({
		invoke: 'kody:@acme/github/listRepos',
		conversationId: 'conv-invoke-killed',
	})
	expect(killed.isError).toBe(true)
	expect(killed.structuredContent.error).toBe(executeInvokeFlagOffMessage)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('execute does not run or reach the registry when live flag resolution fails', async () => {
	const userId = testStableUserIdFromEmail('flag-fail@example.com')
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: {
			userId,
			email: 'flag-fail@example.com',
		},
	})
	mockModule.resolveCallerFeatureFlags.mockRejectedValueOnce(
		new Error('flag resolution failed'),
	)

	const denied = await handler({
		code: shouldNotRunCode,
		conversationId: 'conv-flag-fail',
	})

	expect(denied.isError).toBe(true)
	expect(denied.structuredContent.error).toBe('flag resolution failed')
	expect(denied.structuredContent).not.toHaveProperty('entitlement')
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	expect(mockModule.getCapabilityRegistryForContext).not.toHaveBeenCalled()
})

test('execute does not run or reach the registry when flag evaluation fails closed', async () => {
	const userId = testStableUserIdFromEmail('flag-fail-closed@example.com')
	const handler = await getExecuteHandler({
		baseUrl: 'https://example.com',
		user: {
			userId,
			email: 'flag-fail-closed@example.com',
		},
	})
	mockModule.callerFeatureFlagEvaluationFailed.mockResolvedValueOnce(true)

	const denied = await handler({
		code: shouldNotRunCode,
		conversationId: 'conv-flag-fail-closed',
	})

	expect(denied.isError).toBe(true)
	expect(denied.structuredContent.error).toBe('Feature flag evaluation failed')
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	expect(mockModule.getCapabilityRegistryForContext).not.toHaveBeenCalled()
})

function transportFollowHandle(
	id: string,
	idempotencyKey: string,
): RunRecordHandle {
	return {
		id,
		userId: ownerIdFromStored('user-transport-budget'),
		startedAt: '2026-07-28T00:00:00.000Z',
		persistence: 'eager',
		context: { surface: 'execute', idempotencyKey },
	}
}

const transportCaller = {
	baseUrl: 'https://example.com',
	user: {
		userId: ownerIdFromStored('user-transport-budget'),
		email: 'transport@example.com',
		displayName: 'Transport',
	},
}

test('execute returns the server-assigned key with a finished run and does not assign one for anonymous calls', async () => {
	const anonymous = await getExecuteHandler()
	moduleReturns({ ok: true })
	await anonymous({ code: okCode, conversationId: 'conv-anon-follow' })
	expect(mockModule.beginRunRecord).not.toHaveBeenCalled()

	const handle = transportFollowHandle('run-follow-fast', 'execute:fast-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	moduleReturns({ ok: true }, { runId: 'run-follow-fast' })
	const response = await handler({
		code: okCode,
		conversationId: 'conv-follow-fast',
	})
	expect(response.isError).toBe(false)
	expect(response.structuredContent.inProgress).toBeUndefined()
	expect(response.structuredContent).toMatchObject({
		runId: 'run-follow-fast',
		result: { ok: true },
	})
	expect(response.structuredContent).not.toHaveProperty('idempotencyKey')
	expect(mockModule.ensureRunRecordStarted).not.toHaveBeenCalled()
	expect(mockModule.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			context: expect.objectContaining({
				surface: 'execute',
				idempotencyKey: expect.stringMatching(/^execute:[0-9a-f-]{36}$/),
			}),
		}),
	)
})

test('execute returns runId when the transport budget hits and keeps the sandbox running', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle(
		'run-follow-budget',
		'execute:budget-key',
	)
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	let rejectWork: (error: Error) => void = () => {}
	mockModule.runModuleWithRegistry.mockReturnValueOnce(
		new Promise((_resolve, reject) => {
			rejectWork = reject
		}),
	)
	const controller = new AbortController()
	const response = await runWithInboundRequestSignal(controller.signal, () =>
		handler({ code: okCode, conversationId: 'conv-follow-budget' }),
	)
	expect(response.isError).toBe(false)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-follow-budget',
		idempotencyKey: 'execute:budget-key',
		inProgress: true,
		status: 'running',
	})
	expect(response.structuredContent).not.toHaveProperty('error')
	const text = response.content
		.map((block) => (block.type === 'text' ? block.text : ''))
		.join('\n')
	expect(text).toContain('Poll runGet')
	expect(text).toContain('execute:budget-key')
	expect(text).not.toContain('Error:')
	expect(mockModule.ensureRunRecordStarted).toHaveBeenCalledWith(
		expect.objectContaining({ handle }),
	)
	expect(mockModule.finishRunRecord).not.toHaveBeenCalled()
	expect(mockModule.abandonRunRecord).not.toHaveBeenCalled()
	const options = mockModule.runModuleWithRegistry.mock.calls.at(-1)?.[4] as {
		signal?: AbortSignal
	}
	expect(options.signal?.aborted).toBe(false)
	controller.abort()
	expect(options.signal?.aborted).toBe(false)

	rejectWork(new Error('sandbox blew up'))
	await vi.waitFor(() => {
		expect(mockModule.finishRunRecord).toHaveBeenCalled()
	})
	expect(mockModule.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'error',
			error: expect.objectContaining({ message: 'sandbox blew up' }),
		}),
	)
})

test('execute returns the retained run when it finished as the transport budget elapsed', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle('run-follow-done', 'execute:done-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	mockModule.runModuleWithRegistry.mockReturnValueOnce(new Promise(() => {}))
	mockModule.getRunRecord.mockResolvedValueOnce({
		run: {
			id: 'run-follow-done',
			surface: 'execute',
			status: 'success',
			name: null,
			packageId: null,
			kodyId: null,
			sourceId: null,
			publishedCommit: null,
			storageId: null,
			jobId: null,
			workflowId: null,
			invocationId: null,
			sessionId: null,
			idempotencyKey: 'execute:done-key',
			parentRunId: null,
			startedAt: '2026-07-28T00:00:00.000Z',
			finishedAt: '2026-07-28T00:00:40.000Z',
			durationMs: 40_000,
			errorName: null,
			errorMessage: null,
			errorTriage: null,
			triageNote: null,
			triagedAt: null,
			triagedBy: null,
			metadata: { result: { published: true } },
			logCount: 0,
		},
		logs: [],
	})
	const response = await handler({
		code: okCode,
		conversationId: 'conv-follow-done',
	})
	expect(response.isError).toBe(false)
	expect(response.structuredContent.inProgress).toBeUndefined()
	expect(response.structuredContent).toMatchObject({
		runId: 'run-follow-done',
		idempotencyKey: 'execute:done-key',
		replayed: true,
		result: { published: true },
	})
})

test('execute keeps a caller-supplied idempotency key on the transport-budget follow response', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle('run-supplied', 'caller-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.runModuleWithRegistry.mockReturnValueOnce(new Promise(() => {}))
	mockModule.claimRunRecord.mockResolvedValueOnce({
		claimed: true,
		handle,
	})
	const response = await handler({
		code: okCode,
		idempotencyKey: 'caller-key',
		conversationId: 'conv-supplied-budget',
	})
	expect(mockModule.beginRunRecord).not.toHaveBeenCalled()
	expect(response.isError).toBe(false)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-supplied',
		idempotencyKey: 'caller-key',
		inProgress: true,
		status: 'running',
	})
})

test('execute returns a follow handle while setup is still running and then starts the sandbox', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle('run-slow-setup', 'execute:slow-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	let releaseMemories: (value: null) => void = () => {}
	mockModule.surfaceToolMemories.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseMemories = resolve
			}),
	)
	const response = await handler({
		code: okCode,
		conversationId: 'conv-slow-setup',
	})
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	expect(response.isError).toBe(false)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-slow-setup',
		idempotencyKey: 'execute:slow-key',
		inProgress: true,
		status: 'running',
	})
	mockModule.runModuleWithRegistry.mockReturnValueOnce(new Promise(() => {}))
	releaseMemories(null)
	await vi.waitFor(() => {
		expect(mockModule.runModuleWithRegistry).toHaveBeenCalled()
	})
	const options = mockModule.runModuleWithRegistry.mock.calls.at(-1)?.[4] as {
		signal?: AbortSignal
	}
	expect(options.signal?.aborted).toBe(false)
})

test('execute still returns the run id when the run-log read fails and does not abandon it', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	consoleWarn.mockImplementation(() => {})
	const handle = transportFollowHandle('run-read-failed', 'execute:read-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	mockModule.runModuleWithRegistry.mockReturnValueOnce(new Promise(() => {}))
	mockModule.ensureRunRecordStarted.mockResolvedValueOnce(true)
	mockModule.getRunRecord.mockRejectedValueOnce(new Error('run log down'))
	const response = await handler({
		code: okCode,
		conversationId: 'conv-read-failed',
	})
	expect(response.isError).toBe(false)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-read-failed',
		idempotencyKey: 'execute:read-key',
		inProgress: true,
	})
	expect(mockModule.abandonRunRecord).not.toHaveBeenCalled()
})

test('execute omits an unconfirmed idempotency key from the follow response', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle('run-unconfirmed', 'execute:missing-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	mockModule.runModuleWithRegistry.mockReturnValueOnce(new Promise(() => {}))
	mockModule.ensureRunRecordStarted.mockResolvedValueOnce(false)
	mockModule.getRunRecord.mockResolvedValueOnce(null)
	const response = await handler({
		code: okCode,
		conversationId: 'conv-unconfirmed',
	})
	expect(response.isError).toBe(false)
	expect(response.structuredContent.runId).toBe('run-unconfirmed')
	expect(response.structuredContent.inProgress).toBe(true)
	expect(response.structuredContent).not.toHaveProperty('idempotencyKey')
	const text = response.content
		.map((block) => (block.type === 'text' ? block.text : ''))
		.join('\n')
	expect(text).toContain('Poll runGet')
	expect(text).not.toContain('execute:missing-key')
	expect(mockModule.abandonRunRecord).not.toHaveBeenCalled()
})

test('execute finishes the run when setup fails after the follow response', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	consoleWarn.mockImplementation(() => {})
	const handle = transportFollowHandle('run-setup-failed', 'execute:setup-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	let rejectMemories: (error: Error) => void = () => {}
	mockModule.surfaceToolMemories.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectMemories = reject
			}),
	)
	const response = await handler({
		code: okCode,
		conversationId: 'conv-setup-failed',
	})
	expect(response.structuredContent).toMatchObject({
		runId: 'run-setup-failed',
		inProgress: true,
	})
	expect(mockModule.runModuleWithRegistry).not.toHaveBeenCalled()
	rejectMemories(new Error('memory failed'))
	await vi.waitFor(() => {
		expect(mockModule.finishRunRecord).toHaveBeenCalled()
	})
	expect(mockModule.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'error',
			error: expect.objectContaining({ message: 'memory failed' }),
		}),
	)
})

test('execute finishes the run when setup fails during follow confirmation', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle(
		'run-setup-during-confirm',
		'execute:confirm-key',
	)
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	let rejectMemories: (error: Error) => void = () => {}
	let releaseEnsure: (started: boolean) => void = () => {}
	mockModule.surfaceToolMemories.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectMemories = reject
			}),
	)
	mockModule.ensureRunRecordStarted.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				releaseEnsure = resolve
			}),
	)
	const pending = handler({
		code: okCode,
		conversationId: 'conv-setup-during-confirm',
	})
	await vi.waitFor(() => {
		expect(mockModule.ensureRunRecordStarted).toHaveBeenCalled()
	})
	rejectMemories(new Error('memory failed during confirm'))
	await vi.waitFor(() => {
		expect(mockModule.finishRunRecord).toHaveBeenCalled()
	})
	releaseEnsure(true)
	const response = await pending
	expect(response.structuredContent).toMatchObject({
		runId: 'run-setup-during-confirm',
		inProgress: true,
	})
	expect(mockModule.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			handle,
			status: 'error',
			error: expect.objectContaining({
				message: 'memory failed during confirm',
			}),
		}),
	)
	expect(mockModule.abandonRunRecord).not.toHaveBeenCalled()
})

test('execute returns the run id when the caller cancels after the transport budget', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle('run-cancelled', 'execute:cancel-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	mockModule.runModuleWithRegistry.mockReturnValueOnce(new Promise(() => {}))
	const controller = new AbortController()
	controller.abort(new DOMException('The operation was aborted', 'AbortError'))
	const response = await runWithInboundRequestSignal(controller.signal, () =>
		handler({ code: okCode, conversationId: 'conv-cancelled' }),
	)
	expect(response.isError).toBe(false)
	expect(response.structuredContent).toMatchObject({
		runId: 'run-cancelled',
		idempotencyKey: 'execute:cancel-key',
		inProgress: true,
		status: 'running',
	})
	expect(mockModule.abandonRunRecord).not.toHaveBeenCalled()
	expect(mockModule.finishRunRecord).not.toHaveBeenCalled()
})

test('execute records fleet last-success when a detached run finishes', async () => {
	transportBudgetMock.remainingMs = 0
	onTestFinished(() => {
		transportBudgetMock.remainingMs = null
	})
	const handle = transportFollowHandle('run-heartbeat', 'execute:heartbeat-key')
	const handler = await getExecuteHandler(transportCaller)
	mockModule.beginRunRecord.mockReturnValueOnce(handle)
	let resolveWork: (value: {
		result: { ok: true }
		logs: []
	}) => void = () => {}
	mockModule.runModuleWithRegistry.mockReturnValueOnce(
		new Promise((resolve) => {
			resolveWork = resolve
		}),
	)
	const response = await handler({
		code: okCode,
		conversationId: 'conv-heartbeat',
	})
	expect(response.structuredContent.inProgress).toBe(true)
	expect(heartbeatMock.scheduleFleetExecuteLastSuccess).not.toHaveBeenCalled()
	resolveWork({ result: { ok: true }, logs: [] })
	await vi.waitFor(() => {
		expect(heartbeatMock.scheduleFleetExecuteLastSuccess).toHaveBeenCalled()
	})
})
