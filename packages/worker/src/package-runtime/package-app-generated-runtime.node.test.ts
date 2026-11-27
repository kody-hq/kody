import { readFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { secretAuthorityArgName } from '#mcp/secrets/secret-authority.ts'
import { packageAppCallerDisconnectGraceMs } from '#worker/package-runtime/package-app-diagnostics.ts'

const packageAppSourceText = await readFile(
	new URL('./package-app.ts', import.meta.url),
	'utf8',
)

function extractGeneratedSource(startMarker: string, endMarker: string) {
	const start = packageAppSourceText.indexOf(startMarker)
	const end = packageAppSourceText.indexOf(endMarker, start)
	if (start < 0 || end < 0) {
		throw new Error(`${startMarker} source was not found.`)
	}
	return packageAppSourceText
		.slice(start, end)
		.replaceAll('\\\\', '\\')
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${')
}

const kodyProxySource = extractGeneratedSource(
	'function createKodyProxy(runtimeBridge, mcpServerNamesOrLoader, identity = null) {',
	'\nfunction createRealtimeProxy',
)
const identityOnlyAnswerSource = extractGeneratedSource(
	'function __kodyIdentityOnlyAnswer(identity, name) {',
	'\nlet __kodyCapturedRuntimeBridge',
)

function createKodyProxyForTest(
	runtimeBridge: unknown,
	mcpServerNames: Array<string> | (() => Promise<Array<string>>) = [],
	identity: unknown = null,
) {
	return new Function(
		'runtimeBridge',
		'mcpServerNamesOrLoader',
		'identity',
		`function __kodyCurrentVisitTicket() { return null; }\nfunction __kodyTicketNamesVisitor() { return false; }\n${identityOnlyAnswerSource}\n${kodyProxySource}; return createKodyProxy(runtimeBridge, mcpServerNamesOrLoader, identity);`,
	)(runtimeBridge, mcpServerNames, identity) as Record<string, unknown>
}

/** Workerd-style: [[OwnPropertyKeys]] then GOPD.value (not plain Get). */
function getViaOwnKeysThenGopd(target: object, name: string): unknown {
	if (!Reflect.ownKeys(target).includes(name)) return undefined
	return Reflect.getOwnPropertyDescriptor(target, name)?.value
}

function createWorkflowsProxyForTest(runtimeBridge: unknown) {
	return new Function(
		'runtimeBridge',
		`function __kodyCurrentVisitTicket() { return null; }\n${extractGeneratedSource(
			'function createWorkflowsProxy(runtimeBridge) {',
			'\nfunction createAuthenticatedFetchHelper',
		)}; return createWorkflowsProxy(runtimeBridge);`,
	)(runtimeBridge) as { create(input: unknown): Promise<unknown> }
}

function createRuntimeRunHelpersForTest() {
	return new Function(
		`${extractGeneratedSource(
			'async function startRuntimeRun(runtimeBridge, input) {',
			'\nfunction resolveRealtimeHandler',
		)}; return { startRuntimeRun, finishRuntimeRun, serveThroughCallerDisconnect };`,
	)() as {
		serveThroughCallerDisconnect: (
			executionCtx: { waitUntil: (promise: Promise<unknown>) => void },
			request: { signal?: AbortSignal },
			input: {
				graceMs: number
				handle: () => Promise<unknown>
				onDisconnect: (elapsedMs: number) => void
				onGraceExpired: () => void
			},
		) => Promise<unknown>
		startRuntimeRun: (
			runtimeBridge: {
				packageRuntimeRunStart: (input: unknown) => Promise<unknown>
			},
			input: unknown,
		) => Promise<unknown>
		finishRuntimeRun: (
			runtimeBridge: {
				packageRuntimeRunFinish: (input: unknown) => Promise<unknown>
			},
			executionCtx: { waitUntil: (promise: Promise<unknown>) => void },
			input: Record<string, unknown>,
		) => void
	}
}

test('package app run-record finish waits for begin inside waitUntil, not on the response path', async () => {
	const { startRuntimeRun, finishRuntimeRun } = createRuntimeRunHelpersForTest()
	let resolveStart: ((value: { id: string }) => void) | undefined
	const startGate = new Promise<{ id: string }>((resolve) => {
		resolveStart = resolve
	})
	const startCalls: Array<unknown> = []
	const finishCalls: Array<unknown> = []
	const waitUntilTasks: Array<Promise<unknown>> = []
	const runtimeBridge = {
		packageRuntimeRunStart: async (input: unknown) => {
			startCalls.push(input)
			return await startGate
		},
		packageRuntimeRunFinish: async (input: unknown) => {
			finishCalls.push(input)
			return { ok: true }
		},
	}

	const runtimeRun = startRuntimeRun(runtimeBridge, {
		surface: 'app_fetch',
		name: '/',
	})
	finishRuntimeRun(
		runtimeBridge,
		{ waitUntil: (promise) => void waitUntilTasks.push(promise) },
		{ run: runtimeRun, status: 'success', metadata: { httpStatus: 200 } },
	)

	expect(startCalls).toEqual([{ surface: 'app_fetch', name: '/' }])
	expect(finishCalls).toEqual([])
	expect(waitUntilTasks).toHaveLength(1)

	resolveStart?.({ id: 'run-1' })
	await Promise.all(waitUntilTasks)
	expect(finishCalls).toEqual([
		{ run: { id: 'run-1' }, status: 'success', metadata: { httpStatus: 200 } },
	])
})

function serveDisconnectingRequestForTest() {
	const { serveThroughCallerDisconnect } = createRuntimeRunHelpersForTest()
	const caller = new AbortController()
	const waitUntilTasks: Array<Promise<unknown>> = []
	const events: Array<string> = []
	let respond: ((value: string) => void) | undefined
	const served = serveThroughCallerDisconnect(
		{ waitUntil: (promise) => void waitUntilTasks.push(promise) },
		{ signal: caller.signal },
		{
			graceMs: packageAppCallerDisconnectGraceMs,
			handle: () =>
				new Promise<string>((resolve) => {
					respond = resolve
				}),
			onDisconnect: (elapsedMs) => void events.push(`disconnect:${elapsedMs}`),
			onGraceExpired: () => void events.push('grace-expired'),
		},
	)
	return {
		caller,
		waitUntilTasks,
		events,
		served,
		respond: (value: string) => respond?.(value),
	}
}

test('package app fetch keeps the handler in waitUntil so a caller disconnect does not cancel it', async () => {
	vi.useFakeTimers()
	try {
		const attempt = serveDisconnectingRequestForTest()
		// Held before any disconnect: the runtime only keeps waitUntil work.
		expect(attempt.waitUntilTasks).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(4_000)
		attempt.caller.abort()
		expect(attempt.events).toEqual(['disconnect:4000'])

		await vi.advanceTimersByTimeAsync(10_000)
		attempt.respond('pixel')
		await expect(attempt.served).resolves.toBe('pixel')
		await Promise.all(attempt.waitUntilTasks)
		await vi.advanceTimersByTimeAsync(packageAppCallerDisconnectGraceMs)
		expect(attempt.events).toEqual(['disconnect:4000'])
		expect(vi.getTimerCount()).toBe(0)
	} finally {
		vi.useRealTimers()
	}
})

test('package app fetch reports a handler still running when the caller disconnect grace ends', async () => {
	vi.useFakeTimers()
	try {
		const attempt = serveDisconnectingRequestForTest()
		attempt.caller.abort()
		await vi.advanceTimersByTimeAsync(packageAppCallerDisconnectGraceMs - 1)
		expect(attempt.events).toEqual(['disconnect:0'])

		await vi.advanceTimersByTimeAsync(1)
		expect(attempt.events).toEqual(['disconnect:0', 'grace-expired'])
	} finally {
		vi.useRealTimers()
	}
})

test('package app fetch ignores a caller abort that arrives after the handler responded', async () => {
	const attempt = serveDisconnectingRequestForTest()
	attempt.respond('done')
	await attempt.served
	await Promise.all(attempt.waitUntilTasks)
	attempt.caller.abort()
	expect(attempt.events).toEqual([])
	expect(attempt.waitUntilTasks).toHaveLength(1)
})

test('package app kody.mcp supports calls, advertises connected servers, and dedupes ownKeys', async () => {
	const calls: Array<{ name: string; args: unknown }> = []
	const runtimeBridge = {
		callCapability: async (input: { name: string; args: unknown }) => {
			calls.push(input)
			return { ok: true }
		},
	}
	type McpNamespace = Record<
		string,
		{ set_pin: (args: unknown) => Promise<unknown> }
	>

	// GHSA-5fv3: the run proxy never stamps package authority into args.
	expect(kodyProxySource).not.toContain('__kodySecretAuthorityPackageId')

	const withoutNames = createKodyProxyForTest(runtimeBridge)
	await expect(
		(withoutNames.mcp as McpNamespace)['home']?.set_pin({ pin: '1234' }),
	).resolves.toEqual({ ok: true })
	expect(calls).toEqual([
		{
			name: 'mcp:home:set_pin',
			args: { pin: '1234' },
			visitTicket: null,
		},
	])
	expect(() => withoutNames['mcp:home:set_pin']).toThrow(
		'MCP server tool "mcp:home:set_pin" is not available as a flat kody function.',
	)
	expect('mcp' in withoutNames).toBe(true)
	expect(Reflect.ownKeys(withoutNames.mcp as object)).toEqual([])
	expect(getViaOwnKeysThenGopd(withoutNames.mcp as object, 'home')).toBe(
		undefined,
	)
	// Get stays open even when ownKeys is empty (Node destructure uses Get).
	const { home: openGetHome } = withoutNames.mcp as McpNamespace
	if (!openGetHome) throw new Error('Expected open Get for mcp.home.')
	await expect(openGetHome.set_pin({ pin: '9' })).resolves.toEqual({
		ok: true,
	})

	for (const [names, pin] of [
		[['home', 'mediarss'], '2'],
		[['home', 'home', 'mediarss'], '3'],
	] as const) {
		const proxy = createKodyProxyForTest(runtimeBridge, [...names])
		expect(Reflect.ownKeys(proxy.mcp as object)).toEqual(['home', 'mediarss'])
		const advertisedHome = getViaOwnKeysThenGopd(
			proxy.mcp as object,
			'home',
		) as McpNamespace[string]
		expect(advertisedHome).toBeTypeOf('object')
		await expect(advertisedHome.set_pin({ pin })).resolves.toEqual({
			ok: true,
		})
	}

	expect(calls).toEqual(
		['1234', '9', '2', '3'].map((pin) => ({
			name: 'mcp:home:set_pin',
			args: { pin },
			visitTicket: null,
		})),
	)

	const authoritySymbol = Symbol.for('kody.getSecretAuthority')
	Object.defineProperty(globalThis, authoritySymbol, {
		value: () => 'pkg-stamped',
		configurable: true,
		writable: true,
	})
	try {
		await openGetHome.set_pin({
			pin: '4',
			[secretAuthorityArgName]: 'pkg-forged',
		})
		// A planted getter is ignored; a forged field is passed through to
		// the bridge, which discards it (see the bridge secret-mount test).
		expect(calls.at(-1)).toEqual({
			name: 'mcp:home:set_pin',
			args: { pin: '4', [secretAuthorityArgName]: 'pkg-forged' },
			visitTicket: null,
		})
	} finally {
		delete (globalThis as unknown as Record<symbol, unknown>)[authoritySymbol]
	}
})

test('package app kody proxy answers only metaGetCurrentUser for an identity-only visitor', async () => {
	const calls: Array<string> = []
	const runtimeBridge = {
		callCapability: async ({ name }: { name: string }) => {
			calls.push(name)
			throw new Error('Authenticated MCP user is required for this capability')
		},
	}
	const identity = Object.freeze({
		user_id: 'person-outsider',
		username: 'outsider',
		email: '',
		display_name: 'outsider',
		org: Object.freeze({ slug: 'owner' }),
	})
	const proxy = createKodyProxyForTest(runtimeBridge, [], identity) as Record<
		string,
		(args?: unknown) => Promise<unknown>
	>
	await expect(proxy['metaGetCurrentUser']!({})).resolves.toEqual({
		user_id: 'person-outsider',
		username: 'outsider',
		email: '',
		display_name: 'outsider',
		org: { slug: 'owner' },
		profile: null,
	})
	expect(calls).toEqual([])
	// Every other capability still goes to the anonymous bridge and fails closed.
	await expect(proxy['secretList']!({})).rejects.toThrow(
		'Authenticated MCP user is required',
	)
	expect(calls).toEqual(['secretList'])

	// Without an identity, metaGetCurrentUser goes to the bridge too.
	const anonymous = createKodyProxyForTest(runtimeBridge) as typeof proxy
	await expect(anonymous['metaGetCurrentUser']!({})).rejects.toThrow(
		'Authenticated MCP user is required',
	)
	expect(calls).toEqual(['secretList', 'metaGetCurrentUser'])
})

test('package app kody.mcp loads server names lazily on first mcp touch', async () => {
	let loadCount = 0
	const runtimeBridge = {
		callCapability: async () => ({ ok: true }),
	}
	const proxy = createKodyProxyForTest(runtimeBridge, async () => {
		loadCount += 1
		return ['home']
	})

	expect(loadCount).toBe(0)
	await expect(
		(
			proxy.mcp as Record<
				string,
				{ set_pin: (args: unknown) => Promise<unknown> }
			>
		).home?.set_pin({ pin: '1' }),
	).resolves.toEqual({ ok: true })
	expect(loadCount).toBe(1)

	await Promise.resolve()
	await Promise.resolve()
	expect(Reflect.ownKeys(proxy.mcp as object)).toEqual(['home'])
	expect(loadCount).toBe(1)

	const advertised = getViaOwnKeysThenGopd(proxy.mcp as object, 'home') as {
		set_pin: (args: unknown) => Promise<unknown>
	}
	expect(advertised).toBeTypeOf('object')
	await expect(advertised.set_pin({ pin: '2' })).resolves.toEqual({ ok: true })
	expect(loadCount).toBe(1)
})

test('package app owned limit and spend helpers use the runtime bridge', async () => {
	const runtimeBridge = {
		appRateLimit: vi.fn(async () => ({
			allowed: false,
			retryAfterSeconds: 12,
		})),
		appSpendGet: vi.fn(async () => ({
			month: '2026-05',
			creditsMicroUsd: 2000,
			days: [],
		})),
		callCapability: vi.fn(async () => ({ unexpected: true })),
	}
	const proxy = createKodyProxyForTest(runtimeBridge) as Record<
		string,
		(args?: unknown) => Promise<unknown>
	>

	await expect(
		proxy.appRateLimit!({
			key: 'task',
			limit: 1,
			windowSeconds: 60,
		}),
	).resolves.toEqual({ allowed: false, retryAfterSeconds: 12 })
	await expect(proxy.appSpendGet!({})).resolves.toEqual({
		month: '2026-05',
		creditsMicroUsd: 2000,
		days: [],
	})
	expect(runtimeBridge.appRateLimit).toHaveBeenCalledWith({
		key: 'task',
		limit: 1,
		windowSeconds: 60,
	})
	expect(runtimeBridge.appSpendGet).toHaveBeenCalledWith()
	expect(runtimeBridge.callCapability).not.toHaveBeenCalled()
})

test('package app workflows proxy validates input and forwards to the runtime bridge', async () => {
	const workflows = createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})
	const runAt = '2026-05-03T12:00:00.000Z'
	const code = 'export default async function main() { return { ok: true } }'
	const oneOf = 'workflows.create requires exactly one of exportName or code.'
	const badRunAt =
		'workflows.create requires a valid runAt ISO-8601 date-time string or Date.'
	const event = { workflowName: 'shade-event', exportName: './run-event' }

	const rejected: Array<[unknown, string]> = [
		[undefined, 'workflows.create requires a workflow input object.'],
		[{}, oneOf],
		[{ exportName: './run-event', code, runAt, idempotencyKey: 'k' }, oneOf],
		[{ ...event, runAt: 'not-a-date', idempotencyKey: 'k' }, badRunAt],
		[
			{ ...event, runAt: 'May 3, 2026 12:00:00', idempotencyKey: 'k' },
			badRunAt,
		],
	]
	for (const [input, message] of rejected) {
		await expect(workflows.create(input)).rejects.toThrow(message)
	}

	const params = { eventId: 'event-1' }
	const accepted: Array<[Record<string, unknown>, Record<string, unknown>]> = [
		[
			{ exportName: './run-event', code: '', runAt, idempotencyKey: 'k' },
			{
				exportName: './run-event',
				runAt: new Date(runAt),
				idempotencyKey: 'k',
			},
		],
		[{ exportName: './run-event', code: '' }, { exportName: './run-event' }],
		[
			{ code, runAt, idempotencyKey: 'k', params },
			{ code, runAt: new Date(runAt), idempotencyKey: 'k', params },
		],
		[
			{ code, params },
			{ code, params },
		],
		[
			{ ...event, workflowName: ' shade-event ', runAt, params },
			{
				...event,
				workflowName: ' shade-event ',
				runAt: new Date(runAt),
				params,
			},
		],
	]
	for (const [input, expected] of accepted) {
		await expect(workflows.create(input)).resolves.toEqual(expected)
	}
})
