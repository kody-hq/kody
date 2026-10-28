import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	ecpDefaultGrant,
	ecpHttpSignaturePrefix,
	importEd25519PrivateKey,
	parseEnvelope,
	decodeEnvelopePayload,
	sha256Base64Url,
	signDetached,
	signFrame,
	type EcpFramePayload,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import testKeys from '@kody-internal/shared/execution-context-protocol/vectors/test-keys.json'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	ExecutionContextSessionV1,
	type ExecutionContextLease,
	type ExecutionContextSnapshot,
} from './session-do.ts'

const contextJwk = testKeys.context as {
	kty: 'OKP'
	crv: 'Ed25519'
	x: string
	d: string
}

function snapshot(ecid: string): ExecutionContextSnapshot {
	return {
		ecid,
		name: 'build-box',
		orgId: 'org_test',
		operatorUserId: 'user_operator',
		publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: contextJwk.x },
		grant: ecpDefaultGrant,
		grantVersion: 1,
	}
}

async function connect(ecid: string) {
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName(ecid),
	)
	const issued = await stub.issueConnectTicket({
		snapshot: snapshot(ecid),
		nonce: crypto.randomUUID(),
	})
	if (!issued.ok) throw new Error(issued.code)
	const response = await stub.fetch(
		`https://session.test/connect?ticket=${issued.ticket}`,
		{ headers: { Upgrade: 'websocket' } },
	)
	expect(response.status).toBe(101)
	const ws = response.webSocket!
	ws.accept()
	const inbox: Array<EcpFramePayload> = []
	const waiters: Array<() => void> = []
	ws.addEventListener('message', (event) => {
		const envelope = parseEnvelope(JSON.parse(String(event.data)))
		if (envelope)
			inbox.push(decodeEnvelopePayload(envelope.p) as EcpFramePayload)
		for (const wake of waiters.splice(0)) wake()
	})
	const next = async (type: string) => {
		for (let i = 0; i < 100; i++) {
			const found = inbox.findIndex((frame) => frame.t === type)
			if (found >= 0) return inbox.splice(found, 1)[0]!
			await new Promise<void>((resolve) => {
				waiters.push(resolve)
				setTimeout(resolve, 50)
			})
		}
		throw new Error(`no ${type} frame`)
	}
	const welcome = await next('welcome')
	const key = await importEd25519PrivateKey(contextJwk)
	let seq = 0
	const send = async (
		t: string,
		body: Record<string, unknown>,
		override?: Partial<EcpFramePayload>,
	) => {
		seq += 1
		ws.send(
			await signFrame({
				privateKey: key,
				kid: 'ctx',
				payload: {
					v: 1,
					t,
					ec: ecid,
					sid: welcome.sid,
					seq,
					ts: Date.now(),
					body,
					...override,
				},
			}),
		)
	}
	await send('hello', {
		protocol: { min: 1, max: 1 },
		status: { acceptingRuns: true, running: 0, maxConcurrent: 2 },
	})
	// Sending a WebSocket frame does not wait for its async signature check.
	// Dispatch only after the session has processed hello and accepts runs.
	await expect
		.poll(() => stub.getStatus())
		.toMatchObject({
			online: true,
			acceptingRuns: true,
		})
	return { stub, ws, next, send, key, welcome }
}

function lease(ecid: string, runId: string): ExecutionContextLease {
	return {
		runId,
		ecid,
		requester: { userId: 'user_requester', handle: 'requester' },
		orgId: 'org_test',
		callerScopes: null,
		credentialIds: [],
		runtime: { mode: 'all' },
		deadline: Date.now() + 60_000,
		sharedRun: true,
	}
}

function runRequest(runId: string) {
	return {
		runId,
		deadline: Date.now() + 60_000,
		acceptBy: Date.now() + 3_000,
		requestedBy: {
			userId: 'user_requester',
			handle: 'requester',
			orgId: 'org_test',
			orgSlug: 'test',
		},
		source: {
			kind: 'code' as const,
			code: 'export default () => 1',
			sha256: 'x',
		},
		params: {},
		credentialPicks: {},
		limits: { timeoutMs: 60_000, maxResultBytes: 102_400, memoryMb: 512 },
		grantVersion: 1,
		apiUrl: 'https://api.test',
	}
}

test('tickets are single use, a dispatch with no socket is offline, and nothing starts before commit', async () => {
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName('ec_offline'),
	)
	const nonce = crypto.randomUUID()
	const issued = await stub.issueConnectTicket({
		snapshot: snapshot('ec_offline'),
		nonce,
	})
	expect(issued.ok).toBe(true)
	expect(
		await stub.issueConnectTicket({ snapshot: snapshot('ec_offline'), nonce }),
	).toEqual({
		ok: false,
		code: 'replay',
	})
	const dispatched = await stub.dispatch({
		request: runRequest('run_offline'),
		lease: lease('ec_offline', 'run_offline'),
		runRecord: null,
		position: 1,
	})
	expect(dispatched.outcome).toBe('offline')
	if (!issued.ok) throw new Error('ticket')
	const first = await stub.fetch(
		`https://session.test/connect?ticket=${issued.ticket}`,
		{
			headers: { Upgrade: 'websocket' },
		},
	)
	expect(first.status).toBe(101)
	first.webSocket!.accept()
	const second = await stub.fetch(
		`https://session.test/connect?ticket=${issued.ticket}`,
		{
			headers: { Upgrade: 'websocket' },
		},
	)
	expect(second.status).toBe(401)
	first.webSocket!.close()
})

test('two-phase dispatch: accept, commit, result, then per-hop authorization ends with the lease', async () => {
	const ecid = 'ec_two_phase'
	const { stub, next, send, key } = await connect(ecid)
	const dispatching = stub.dispatch({
		request: runRequest('run_a'),
		lease: lease(ecid, 'run_a'),
		runRecord: null,
		position: 1,
	})
	const request = await next('run.request')
	expect(request.body.runId).toBe('run_a')
	await send('run.accept', { runId: 'run_a' }, { re: request.seq })
	expect(await dispatching).toEqual({ outcome: 'committed' })
	expect((await next('run.commit')).body.runId).toBe('run_a')

	const body = '{"path":"kody.search"}'
	const ts = Date.now()
	const n = crypto.randomUUID().replaceAll('-', '')
	const bodySha256 = await sha256Base64Url(body)
	const message = [
		'POST',
		'/v1/capability-proxy',
		String(ts),
		n,
		bodySha256,
	].join('\n')
	const s = await signDetached({
		prefix: ecpHttpSignaturePrefix,
		message,
		privateKey: key,
	})
	const call = {
		runId: 'run_a',
		signature: { ec: ecid, ts, n, s },
		method: 'POST',
		pathAndQuery: '/v1/capability-proxy',
		bodySha256,
	}
	const authorized = await stub.authorizeRunCall(call)
	expect(authorized.ok && authorized.lease.requester.userId).toBe(
		'user_requester',
	)
	expect(await stub.authorizeRunCall(call)).toEqual({
		ok: false,
		code: 'replay',
	})

	await send('run.result', {
		runId: 'run_a',
		isError: false,
		content: [{ type: 'text', text: '1' }],
		structuredContent: { result: 1 },
	})
	await next('run.result.ack')
	expect(
		await stub.awaitResult({ runId: 'run_a', waitMs: 1000 }),
	).toMatchObject({
		state: 'succeeded',
		result: { structuredContent: { result: 1 } },
	})
	const n2 = crypto.randomUUID().replaceAll('-', '')
	const s2 = await signDetached({
		prefix: ecpHttpSignaturePrefix,
		message: ['POST', '/v1/capability-proxy', String(ts), n2, bodySha256].join(
			'\n',
		),
		privateKey: key,
	})
	expect(
		await stub.authorizeRunCall({
			...call,
			signature: { ec: ecid, ts, n: n2, s: s2 },
		}),
	).toEqual({ ok: false, code: 'lease_ended' })
	const history = await stub.listHistory({})
	expect(history.rows[0]).toMatchObject({
		runId: 'run_a',
		outcome: 'succeeded',
	})
	expect(JSON.stringify(history)).not.toContain('export default')
})

test('API-token and MCP runs carry the API origin the daemon connected through, not the app origin', async () => {
	const ecid = 'ec_api_origin'
	const { stub, next, send } = await connect(ecid)
	// Both API-token and MCP callers route with callerContext.baseUrl, which
	// is the app origin; the daemon only trusts its own API origin.
	for (const runId of ['run_api_token', 'run_mcp']) {
		const dispatching = stub.dispatch({
			request: { ...runRequest(runId), apiUrl: 'https://kody.codes' },
			lease: lease(ecid, runId),
			runRecord: null,
			position: 1,
		})
		const request = await next('run.request')
		expect(request.body).toMatchObject({
			runId,
			apiUrl: 'https://session.test',
		})
		await send('run.accept', { runId }, { re: request.seq })
		expect(await dispatching).toEqual({ outcome: 'committed' })
		expect((await next('run.commit')).body.runId).toBe(runId)
		await send('run.result', {
			runId,
			isError: false,
			content: [{ type: 'text', text: '1' }],
			structuredContent: { result: 1 },
		})
		await next('run.result.ack')
		expect(await stub.awaitResult({ runId, waitMs: 1000 })).toMatchObject({
			state: 'succeeded',
		})
	}
})

test('a reject falls through, and cancel and revocation end leases', async () => {
	const ecid = 'ec_cancel'
	const { stub, next, send, ws } = await connect(ecid)
	const rejected = stub.dispatch({
		request: runRequest('run_r'),
		lease: lease(ecid, 'run_r'),
		runRecord: null,
		position: 1,
	})
	const request = await next('run.request')
	await send(
		'run.reject',
		{ runId: 'run_r', code: 'busy' },
		{ re: request.seq },
	)
	expect(await rejected).toEqual({ outcome: 'rejected', code: 'busy' })

	const committed = stub.dispatch({
		request: runRequest('run_c'),
		lease: lease(ecid, 'run_c'),
		runRecord: null,
		position: 1,
	})
	const second = await next('run.request')
	await send('run.accept', { runId: 'run_c' }, { re: second.seq })
	expect((await committed).outcome).toBe('committed')
	expect(
		await stub.cancel({ runId: 'run_c', reason: 'caller_cancelled' }),
	).toEqual({ cancelled: true })
	expect((await next('run.cancel')).body).toMatchObject({
		runId: 'run_c',
		reason: 'caller_cancelled',
	})
	await send('run.result', {
		runId: 'run_c',
		isError: false,
		structuredContent: { result: 2 },
	})
	expect(await stub.awaitResult({ runId: 'run_c', waitMs: 200 })).toEqual({
		state: 'cancelled',
		reason: 'caller_cancelled',
	})

	const third = stub.dispatch({
		request: runRequest('run_v'),
		lease: lease(ecid, 'run_v'),
		runRecord: null,
		position: 1,
	})
	const r3 = await next('run.request')
	await send('run.accept', { runId: 'run_v' }, { re: r3.seq })
	expect((await third).outcome).toBe('committed')
	expect(
		await stub.endLeases({
			userIds: ['user_requester'],
			reason: 'access_lost',
		}),
	).toEqual({ ended: 1 })
	await stub.revoke({ reason: 'operator' })
	expect((await stub.getStatus()).revoked).toBe(true)
	expect(
		(
			await stub.issueConnectTicket({
				snapshot: snapshot(ecid),
				nonce: 'n-after',
			})
		).ok,
	).toBe(false)
	ws.close()
})

test('a replayed or out-of-order frame closes the socket, and an unsigned ping with a payload is refused', async () => {
	const { ws, next, send } = await connect('ec_replay')
	const closed = new Promise<number>((resolve) =>
		ws.addEventListener('close', (event) => resolve(event.code)),
	)
	ws.send('{"t":"ping","body":{"x":1}}')
	expect((await next('error')).body.code).toBe('bad_signature')
	await expect(closed).resolves.toBe(1008)
	void send
})

test('history purges a requester and keeps nothing but metadata', async () => {
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName('ec_purge'),
	)
	await stub.issueConnectTicket({ snapshot: snapshot('ec_purge'), nonce: 'p1' })
	await stub.dispatch({
		request: runRequest('run_p'),
		lease: lease('ec_purge', 'run_p'),
		runRecord: null,
		position: 2,
	})
	expect((await stub.listHistory({})).rows).toHaveLength(1)
	await stub.noteRanOn({ runId: 'run_p', ranOn: 'cloud' })
	expect((await stub.listHistory({})).rows[0]?.fallback).toEqual({
		position: 2,
		ranOn: 'cloud',
	})
	await stub.purgeRequester({ userId: 'user_requester' })
	expect((await stub.listHistory({})).rows).toHaveLength(0)
	await runInDurableObject(stub, async (instance) => {
		expect(instance).toBeInstanceOf(ExecutionContextSessionV1)
	})
})

test('a malformed ECP_FRAME_SIGNING_KEYS closes the socket loudly, then heals once the keys parse', async () => {
	consoleError.mockImplementation(() => {})
	const ecid = 'ec_bad_keys'
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName(ecid),
	)
	const goodKeys = env.ECP_FRAME_SIGNING_KEYS
	if (!goodKeys) throw new Error('test signing keys missing')
	// What the dotenv-staged deploy secret looked like: escaped quotes.
	const setKeys = (raw: string) =>
		runInDurableObject(stub, (instance) => {
			;(instance as unknown as { env: Env }).env = {
				...env,
				ECP_FRAME_SIGNING_KEYS: raw,
			}
		})
	await setKeys(JSON.stringify(goodKeys).slice(1, -1))
	const issued = await stub.issueConnectTicket({
		snapshot: snapshot(ecid),
		nonce: crypto.randomUUID(),
	})
	if (!issued.ok) throw new Error(issued.code)
	const response = await stub.fetch(
		`https://session.test/connect?ticket=${issued.ticket}`,
		{ headers: { Upgrade: 'websocket' } },
	)
	expect(response.status).toBe(101)
	const ws = response.webSocket!
	const frames: Array<string> = []
	ws.addEventListener('message', (event) => frames.push(String(event.data)))
	const closed = new Promise<{ code: number; reason: string }>((resolve) =>
		ws.addEventListener('close', (event) =>
			resolve({ code: event.code, reason: event.reason }),
		),
	)
	ws.accept()
	await expect(closed).resolves.toEqual({
		code: 1011,
		reason: 'server keys invalid',
	})
	expect(frames).toEqual([])
	expect(consoleError).toHaveBeenCalledWith(
		'execution_context_frame_send_failed',
		expect.objectContaining({
			ecid,
			frameType: 'welcome',
			reason: 'server keys invalid',
			error: 'ECP_FRAME_SIGNING_KEYS is not valid JSON.',
		}),
	)
	expect(JSON.stringify(consoleError.mock.calls)).not.toContain('"d"')

	await setKeys(goodKeys)
	const { welcome } = await connect(ecid)
	expect(welcome.t).toBe('welcome')
})
