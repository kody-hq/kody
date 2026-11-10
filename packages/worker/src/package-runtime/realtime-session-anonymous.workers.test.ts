import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	anonymousRealtimeLimits,
	packageRealtimePingMessage,
	packageRealtimePongMessage,
	packageRealtimeSessionRpc,
	type PackageRealtimeConnectOptions,
	type PackageRealtimeSession,
} from './realtime-session.ts'

const approvedCommit = 'commit-approved'

type HookCall = {
	payload: {
		event: string
		facet: string
		visitor: unknown
		session: { id: string; anonymous: boolean; visitor: unknown }
		message?: { text: string | null } | null
	}
	requiredCommit: string | null
}

type TestInstance = {
	resolveRealtimeHookResult: (input: HookCall) => Promise<Array<unknown>>
	resolvePublicAccessCommit: () => Promise<string | null>
	recordSessionUsage: (binding: unknown, session: { id: string }) => void
	socketCount: (tag: string) => number
	admitPublicSocket: (ipHash: string) => Response | null
	broadcast: (input: {
		data: unknown
	}) => Promise<{ deliveredCount: number; limitedCount?: number }>
	emitToSession: (
		sessionId: string,
		data: unknown,
	) => Promise<{ delivered: boolean; reason?: string }>
	getPackageAppWorker: (
		binding: unknown,
		requiredCommit: string | null,
	) => Promise<unknown>
	getResolvedPackageAppWorkerCacheKey: () => Promise<string>
	cachedAppWorkerKey: string | null
	cachedAppWorkerBuildInputPromise: Promise<unknown> | null
	stateSnapshot: {
		sessions: Record<string, { connectedAt: string; topics: Array<string> }>
	}
	alarm: () => Promise<void>
}

function createBinding() {
	return {
		env,
		userId: ownerIdFromStored('user-anon-realtime'),
		packageId: `package-${crypto.randomUUID()}`,
		kodyId: 'podium',
		sourceId: 'source-1',
		baseUrl: 'https://example.com',
	}
}

function getStub(binding: ReturnType<typeof createBinding>) {
	const namespace =
		env.PACKAGE_REALTIME_SESSION as DurableObjectNamespace<PackageRealtimeSession>
	return namespace.get(
		namespace.idFromName(JSON.stringify([binding.userId, binding.packageId])),
	)
}

/**
 * Stubs the app hook and the approved-commit lookup so a test controls what
 * the app would do and which commit is approved, and records hook calls.
 */
async function prepare(
	binding: ReturnType<typeof createBinding>,
	input: {
		liveApprovedCommit?: string | null
		hookActions?: Array<unknown>
	} = {},
) {
	const calls: Array<HookCall> = []
	const usage: Array<string> = []
	await runInDurableObject(getStub(binding), async (instance) => {
		const anyInstance = instance as unknown as TestInstance
		anyInstance.resolveRealtimeHookResult = async (call) => {
			calls.push(call)
			return input.hookActions ?? []
		}
		anyInstance.resolvePublicAccessCommit = async () =>
			input.liveApprovedCommit === undefined
				? approvedCommit
				: input.liveApprovedCommit
		anyInstance.recordSessionUsage = (_binding, session) => {
			usage.push(session.id)
		}
	})
	return { calls, usage }
}

async function connect(
	binding: ReturnType<typeof createBinding>,
	options: PackageRealtimeConnectOptions,
	facet = 'room',
) {
	const response = await packageRealtimeSessionRpc(binding).connect(
		new Request(`https://kentcdodds.kody.run/podium/ws/${facet}`, {
			headers: { Upgrade: 'websocket' },
		}),
		facet,
		options,
	)
	const socket = response.webSocket
	socket?.accept()
	const messages: Array<string> = []
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		socket?.addEventListener('close', (event) => {
			resolve({ code: event.code, reason: event.reason })
		})
	})
	socket?.addEventListener('message', (event) => {
		messages.push(String(event.data))
	})
	return { response, socket, messages, closed }
}

const anonymousReceive: PackageRealtimeConnectOptions = {
	access: 'receive',
	visitor: null,
	approvedCommit,
	ipHash: 'ip-a',
}

const anonymousTwoWay: PackageRealtimeConnectOptions = {
	...anonymousReceive,
	access: 'two-way',
}

async function waitFor(check: () => boolean) {
	for (let i = 0; i < 100; i += 1) {
		if (check()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error('Timed out waiting for condition.')
}

test('receive-only anonymous sockets get broadcasts, answer pings, never run hooks, and close with 1008 on inbound data', async () => {
	const binding = createBinding()
	const { calls, usage } = await prepare(binding)
	const anonymous = await connect(binding, anonymousReceive)
	expect(anonymous.response.status).toBe(101)

	const listed = await packageRealtimeSessionRpc(binding).listSessions()
	expect(listed.sessions).toEqual([
		expect.objectContaining({
			facet: 'room',
			anonymous: true,
			visitor: null,
		}),
	])

	const broadcast = await packageRealtimeSessionRpc(binding).broadcast({
		data: { type: 'tally', votes: 3 },
	})
	expect(broadcast).toMatchObject({ deliveredCount: 1 })
	await waitFor(() => anonymous.messages.length === 1)
	expect(JSON.parse(anonymous.messages[0] ?? '')).toEqual({
		type: 'tally',
		votes: 3,
	})

	anonymous.socket?.send(packageRealtimePingMessage)
	await waitFor(() => anonymous.messages.length === 2)
	expect(anonymous.messages[1]).toBe(packageRealtimePongMessage)

	anonymous.socket?.send('vote:a')
	await expect(anonymous.closed).resolves.toMatchObject({
		code: 1008,
		reason: 'receive-only',
	})
	await waitFor(() => usage.length === 1)
	expect(calls).toEqual([])
})

test('two-way anonymous messages reach the app hook with an anonymous visitor at the approved commit', async () => {
	const binding = createBinding()
	const { calls } = await prepare(binding, {
		hookActions: [{ type: 'subscribe', topic: 'votes' }],
	})
	const anonymous = await connect(binding, anonymousTwoWay)
	expect(anonymous.response.status).toBe(101)
	expect(calls.map((call) => call.payload.event)).toEqual(['connect'])

	anonymous.socket?.send('vote:a')
	await waitFor(() => calls.length === 2)
	expect(calls[1]).toMatchObject({
		requiredCommit: approvedCommit,
		payload: {
			event: 'message',
			facet: 'room',
			visitor: null,
			session: { anonymous: true, visitor: null },
			message: { text: 'vote:a' },
		},
	})

	// Topics persist per socket, never as one whole-session snapshot.
	const sessionId = calls[1]?.payload.session.id ?? ''
	await runInDurableObject(getStub(binding), async (_instance, state) => {
		await expect(
			state.storage.get(`session-state:${sessionId}`),
		).resolves.toMatchObject({ topics: ['votes'] })
		await expect(
			state.storage.get('package-realtime-state'),
		).resolves.toBeUndefined()
	})
	anonymous.socket?.close(1000, 'done')
})

test('signed-in visitors are named in hooks and session lists; members stay uncapped', async () => {
	const binding = createBinding()
	const { calls } = await prepare(binding)
	const outsider = await connect(binding, {
		...anonymousTwoWay,
		visitor: { userId: 'person-outsider', username: 'outsider', role: null },
	})
	const member = await connect(binding, {
		access: 'member',
		visitor: { userId: 'person-member', username: 'member', role: 'owner' },
	})
	expect(outsider.response.status).toBe(101)
	expect(member.response.status).toBe(101)
	expect(calls.map((call) => call.payload.visitor)).toEqual([
		{ userId: 'person-outsider', username: 'outsider', role: null },
		{ userId: 'person-member', username: 'member', role: 'owner' },
	])
	expect(calls.map((call) => call.requiredCommit)).toEqual([
		approvedCommit,
		null,
	])
	const { sessions } = await packageRealtimeSessionRpc(binding).listSessions()
	expect(sessions.map((session) => session.anonymous).sort()).toEqual([
		false,
		false,
	])
	outsider.socket?.close(1000, 'done')
	member.socket?.close(1000, 'done')
})

test('a public socket whose approved commit is no longer served closes with 1012 instead of running the hook', async () => {
	const binding = createBinding()
	const { calls } = await prepare(binding, {
		liveApprovedCommit: 'commit-newer',
	})
	const anonymous = await connect(binding, anonymousTwoWay)
	expect(anonymous.response.status).toBe(101)
	const connectCalls = calls.length

	anonymous.socket?.send('vote:a')
	await expect(anonymous.closed).resolves.toMatchObject({
		code: 1012,
		reason: 'app-updated',
	})
	expect(calls).toHaveLength(connectCalls)
})

test('hooks for a public socket refuse to build any commit but the approved one', async () => {
	const binding = createBinding()
	await runInDurableObject(getStub(binding), async (instance) => {
		const anyInstance = instance as unknown as TestInstance
		anyInstance.getResolvedPackageAppWorkerCacheKey = async () => 'key'
		anyInstance.cachedAppWorkerKey = 'key'
		anyInstance.cachedAppWorkerBuildInputPromise = Promise.resolve({
			savedPackage: { publishedCommit: 'commit-live-unapproved' },
		})
		const { env: _env, ...state } = binding
		await expect(
			anyInstance.getPackageAppWorker(state, approvedCommit),
		).rejects.toMatchObject({ name: 'PackageRealtimePinMismatchError' })
	})
})

test('public connects are refused without an approved commit', async () => {
	const binding = createBinding()
	await prepare(binding)
	const refused = await connect(binding, {
		...anonymousReceive,
		approvedCommit: null,
	})
	expect(refused.response.status).toBe(403)
})

test('anonymous socket caps: per IP, per app, and connects per minute', async () => {
	const binding = createBinding()
	await prepare(binding)
	const sockets = []
	for (let i = 0; i < anonymousRealtimeLimits.socketsPerIp; i += 1) {
		const opened = await connect(binding, anonymousReceive)
		expect(opened.response.status).toBe(101)
		sockets.push(opened)
	}
	const overIp = await connect(binding, anonymousReceive)
	expect(overIp.response.status).toBe(429)
	const otherIp = await connect(binding, {
		...anonymousReceive,
		ipHash: 'ip-b',
	})
	expect(otherIp.response.status).toBe(101)
	// Members are not counted against or refused by the public caps.
	const member = await connect(binding, { access: 'member', visitor: null })
	expect(member.response.status).toBe(101)

	await runInDurableObject(getStub(binding), async (instance) => {
		const anyInstance = instance as unknown as TestInstance
		const realCount = anyInstance.socketCount.bind(anyInstance)
		anyInstance.socketCount = (tag) =>
			tag === 'public' ? anonymousRealtimeLimits.socketsPerApp : realCount(tag)
		expect(anyInstance.admitPublicSocket('ip-c')?.status).toBe(429)
		anyInstance.socketCount = () => 0
		for (
			let i = 0;
			i < anonymousRealtimeLimits.connectsPerIpPerMinute;
			i += 1
		) {
			expect(anyInstance.admitPublicSocket('ip-d')).toBeNull()
		}
		const overRate = anyInstance.admitPublicSocket('ip-d')
		expect(overRate?.status).toBe(429)
		expect(overRate?.headers.get('Retry-After')).toBe('60')
	})
	for (const opened of [...sockets, otherIp, member]) {
		opened.socket?.close(1000, 'done')
	}
})

test('two-way inbound size and rate caps close the socket', async () => {
	const binding = createBinding()
	await prepare(binding)
	const tooBig = await connect(binding, anonymousTwoWay)
	tooBig.socket?.send('x'.repeat(anonymousRealtimeLimits.maxPayloadBytes + 1))
	await expect(tooBig.closed).resolves.toMatchObject({
		code: 1009,
		reason: 'message-too-big',
	})

	const chatty = await connect(binding, { ...anonymousTwoWay, ipHash: 'ip-z' })
	for (
		let i = 0;
		i <= anonymousRealtimeLimits.inboundMessageBurst + 5;
		i += 1
	) {
		chatty.socket?.send(`m${String(i)}`)
	}
	await expect(chatty.closed).resolves.toMatchObject({
		code: 1008,
		reason: 'rate-limited',
	})
})

test('broadcast and emit payloads over 64 KiB and broadcasts over the soft rate skip public sockets only', async () => {
	const binding = createBinding()
	await prepare(binding)
	const anonymous = await connect(binding, anonymousReceive)
	const member = await connect(binding, { access: 'member', visitor: null })
	const rpc = packageRealtimeSessionRpc(binding)
	const big = 'x'.repeat(anonymousRealtimeLimits.maxPayloadBytes + 1)

	await expect(rpc.broadcast({ data: big })).resolves.toMatchObject({
		deliveredCount: 1,
		limitedCount: 1,
	})
	const anonymousId =
		(await rpc.listSessions()).sessions.find((session) => session.anonymous)
			?.session_id ?? ''
	await expect(rpc.emit(anonymousId, big)).resolves.toEqual({
		delivered: false,
		reason: 'payload_too_large',
	})

	let limited = 0
	for (let i = 0; i < anonymousRealtimeLimits.broadcastsPerSecond + 5; i += 1) {
		const result = await rpc.broadcast({ data: { i } })
		limited += result.limitedCount ?? 0
	}
	expect(limited).toBeGreaterThan(0)
	expect(member.messages.length).toBeGreaterThanOrEqual(
		anonymousRealtimeLimits.broadcastsPerSecond + 5,
	)
	anonymous.socket?.close(1000, 'done')
	member.socket?.close(1000, 'done')
})

test('the access alarm closes public sockets past 24 hours and records the session', async () => {
	const binding = createBinding()
	const { usage } = await prepare(binding)
	const anonymous = await connect(binding, anonymousReceive)
	const member = await connect(binding, { access: 'member', visitor: null })
	await runInDurableObject(getStub(binding), async (instance, state) => {
		const anyInstance = instance as unknown as TestInstance
		await expect(state.storage.getAlarm()).resolves.not.toBeNull()
		for (const session of Object.values(anyInstance.stateSnapshot.sessions)) {
			session.connectedAt = new Date(
				Date.now() - anonymousRealtimeLimits.maxSessionMs - 1,
			).toISOString()
		}
		await anyInstance.alarm()
	})
	await expect(anonymous.closed).resolves.toMatchObject({
		code: 1001,
		reason: 'max-session-duration',
	})
	await waitFor(() => usage.length === 1)
	const { sessions } = await packageRealtimeSessionRpc(binding).listSessions()
	expect(sessions).toHaveLength(1)
	expect(sessions[0]?.anonymous).toBe(false)
	member.socket?.close(1000, 'done')
})

test('the access alarm closes public sockets once the app no longer serves their approved commit', async () => {
	const binding = createBinding()
	await prepare(binding)
	const anonymous = await connect(binding, anonymousReceive)
	await runInDurableObject(getStub(binding), async (instance) => {
		const anyInstance = instance as unknown as TestInstance
		anyInstance.resolvePublicAccessCommit = async () => null
		await anyInstance.alarm()
	})
	await expect(anonymous.closed).resolves.toMatchObject({
		code: 1012,
		reason: 'app-updated',
	})
})
