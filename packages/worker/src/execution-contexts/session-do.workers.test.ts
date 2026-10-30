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
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beginRunRecord, getRunRecord } from '#worker/run-records/service.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
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

async function connect(ecid: string, hello: Record<string, unknown> = {}) {
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
	// 100 × 50ms (~5s) timed out under full validate / CI workerd load while
	// isolation stayed green (#4469, #4477, #4484). Stay under the workers-unit
	// 40s test budget so a slow first `run.request` is not a false flake.
	const frameWaitMs = 30_000
	const next = async (type: string) => {
		const deadline = Date.now() + frameWaitMs
		for (;;) {
			const found = inbox.findIndex((frame) => frame.t === type)
			if (found >= 0) return inbox.splice(found, 1)[0]!
			if (Date.now() >= deadline) {
				throw new Error(`no ${type} frame`)
			}
			await new Promise<void>((resolve) => {
				waiters.push(resolve)
				setTimeout(resolve, 50)
			})
		}
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
		...hello,
	})
	// Sending a WebSocket frame does not wait for its async signature check.
	// Dispatch only after the session has processed hello and accepts runs.
	await expect
		.poll(() => stub.getStatus(), { timeout: frameWaitMs })
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
}, 60_000)

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
}, 60_000)

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

test('a queued run waits for reconnect and expires on the alarm', async () => {
	const ecid = 'ec_queue'
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName(ecid),
	)
	await stub.issueConnectTicket({
		snapshot: snapshot(ecid),
		nonce: crypto.randomUUID(),
	})
	const expiresAt = Date.now() + 60_000
	expect(
		await stub.enqueue({
			request: runRequest('run_queued'),
			lease: lease(ecid, 'run_queued'),
			runRecord: null,
			requires: [],
			position: 1,
			expiresAt,
		}),
	).toEqual({ queued: true })
	expect(await stub.listQueued()).toEqual([
		expect.objectContaining({ runId: 'run_queued', expiresAt }),
	])
	await runInDurableObject(stub, async (instance, state) => {
		state.storage.sql.exec(`UPDATE queued SET expires_at = ?`, Date.now() - 1)
		await instance.alarm()
	})
	expect(await stub.listQueued()).toEqual([])
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

test('revoking a context fails its queued runs at once', async () => {
	const ecid = 'ec_queue_revoked'
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName(ecid),
	)
	await stub.issueConnectTicket({
		snapshot: snapshot(ecid),
		nonce: crypto.randomUUID(),
	})
	await stub.enqueue({
		request: runRequest('run_queued_revoked'),
		lease: lease(ecid, 'run_queued_revoked'),
		runRecord: null,
		requires: [],
		position: 1,
		expiresAt: Date.now() + 60_000,
	})
	expect(await stub.listQueued()).toHaveLength(1)
	await stub.revoke({ reason: 'test' })
	expect(await stub.listQueued()).toEqual([])
})

test('history keeps a failure reason and error summary for failed, cancelled and lost runs', async () => {
	const ecid = 'ec_failures'
	const { stub, next, send, ws } = await connect(ecid)
	const commit = async (runId: string) => {
		const dispatching = stub.dispatch({
			request: runRequest(runId),
			lease: lease(ecid, runId),
			runRecord: null,
			position: 1,
		})
		const request = await next('run.request')
		await send('run.accept', { runId }, { re: request.seq })
		expect((await dispatching).outcome).toBe('committed')
		await next('run.commit')
	}

	await commit('run_failed')
	await send('run.result', {
		runId: 'run_failed',
		isError: true,
		content: [{ type: 'text', text: 'Error: missing credential' }],
		structuredContent: {
			error: `Credential "example" is not available here. ${'x'.repeat(600)}`,
			errorCode: 'credential_unavailable',
		},
	})
	await next('run.result.ack')
	await commit('run_cancelled')
	await stub.cancel({ runId: 'run_cancelled', reason: 'caller_cancelled' })
	await commit('run_lost')
	// With the daemon still connected a late alarm cancels; gone, it is lost.
	ws.close()
	await expect.poll(() => stub.getStatus()).toMatchObject({ online: false })
	await runInDurableObject(stub, async (instance, state) => {
		state.storage.sql.exec(
			`UPDATE runs SET deadline = ? WHERE run_id = 'run_lost'`,
			Date.now() - 60_000,
		)
		await instance.alarm()
	})

	const rows = new Map(
		(await stub.listHistory({})).rows.map((row) => [row.runId, row]),
	)
	const failed = rows.get('run_failed')
	expect(failed).toMatchObject({
		outcome: 'failed',
		failureReason: 'credential_unavailable',
	})
	expect(failed?.errorSummary).toMatch(/^Credential "example" is not available/)
	expect(failed?.errorSummary?.length).toBeLessThanOrEqual(500)
	expect(rows.get('run_cancelled')).toMatchObject({
		outcome: 'cancelled',
		cancelReason: 'caller_cancelled',
		failureReason: 'caller_cancelled',
		errorSummary: 'The run was cancelled (caller_cancelled).',
	})
	expect(rows.get('run_lost')).toMatchObject({
		outcome: 'lost',
		failureReason: 'execution_context_lost',
		errorSummary: expect.stringContaining('execution_context_lost'),
	})

	expect(
		await stub.getStartedRun({
			runId: 'run_failed',
			requesterUserId: 'user_requester',
			orgId: 'org_test',
		}),
	).toMatchObject({
		ecid,
		name: 'build-box',
		row: { runId: 'run_failed', failureReason: 'credential_unavailable' },
	})
	expect(
		await stub.getStartedRun({
			runId: 'run_failed',
			requesterUserId: 'user_someone_else',
			orgId: 'org_test',
		}),
	).toBeNull()
}, 60_000)

test('a run that never started here is not returned as a started run', async () => {
	const stub = env.EXECUTION_CONTEXT_SESSION.get(
		env.EXECUTION_CONTEXT_SESSION.idFromName('ec_never_started'),
	)
	await stub.issueConnectTicket({
		snapshot: snapshot('ec_never_started'),
		nonce: crypto.randomUUID(),
	})
	await stub.dispatch({
		request: runRequest('run_skipped'),
		lease: lease('ec_never_started', 'run_skipped'),
		runRecord: null,
		position: 1,
	})
	expect(
		await stub.getStartedRun({
			runId: 'run_skipped',
			requesterUserId: 'user_requester',
			orgId: 'org_test',
		}),
	).toBeNull()
})

test('a deadline stop is a cancel with cancelReason deadline and completes the main run record', async () => {
	const ecid = 'ec_deadline'
	const { stub, next, send } = await connect(ecid)
	const userId = 'user_requester'
	const pending: Array<Promise<unknown>> = []
	const handleFor = () =>
		beginRunRecord({
			env,
			userId: ownerIdFromStored(userId),
			context: {
				surface: 'execute',
				name: null,
				idempotencyKey: `key-${crypto.randomUUID()}`,
				startedBy: {
					userId,
					username: 'requester',
					client: 'cli',
					label: 'example-token',
				},
			},
			waitUntil: (promise) => {
				pending.push(promise)
			},
		})
	const commit = async (runId: string, handle: RunRecordHandle | null) => {
		const dispatching = stub.dispatch({
			request: runRequest(runId),
			lease: lease(ecid, runId),
			runRecord: handle,
			position: 1,
		})
		const request = await next('run.request')
		await send('run.accept', { runId }, { re: request.seq })
		expect((await dispatching).outcome).toBe('committed')
		await next('run.commit')
	}

	const local = handleFor()
	await commit('run_local_deadline', local)
	await send('run.result', {
		runId: 'run_local_deadline',
		isError: true,
		content: [
			{ type: 'text', text: 'Local execute was cancelled before it finished.' },
		],
		structuredContent: {
			error: 'Local execute was cancelled before it finished.',
		},
		cancelReason: 'deadline',
	})
	await next('run.result.ack')

	const server = handleFor()
	await commit('run_server_deadline', server)
	await runInDurableObject(stub, async (instance, state) => {
		state.storage.sql.exec(
			`UPDATE runs SET deadline = ? WHERE run_id = 'run_server_deadline'`,
			Date.now() - 10_000,
		)
		await instance.alarm()
	})
	expect((await next('run.cancel')).body).toMatchObject({
		runId: 'run_server_deadline',
		reason: 'deadline',
	})
	await drainWaitUntil(pending)

	const rows = new Map(
		(await stub.listHistory({})).rows.map((row) => [row.runId, row]),
	)
	for (const runId of ['run_local_deadline', 'run_server_deadline']) {
		expect(rows.get(runId)).toMatchObject({
			outcome: 'cancelled',
			cancelReason: 'deadline',
			failureReason: 'deadline',
			errorSummary: 'The run was cancelled (deadline).',
		})
	}
	expect(
		await stub.awaitResult({ runId: 'run_local_deadline', waitMs: 0 }),
	).toEqual({ state: 'cancelled', reason: 'deadline' })

	for (const handle of [local, server]) {
		if (!handle) throw new Error('run record handle')
		const record = await getRunRecord({
			env,
			userId: ownerIdFromStored(userId),
			runId: handle.id,
		})
		expect(record?.run).toMatchObject({
			id: handle.id,
			status: 'error',
			idempotencyKey: handle.context.idempotencyKey,
			startedBy: { userId, username: 'requester', client: 'cli' },
			errorMessage: 'The run was cancelled (deadline).',
		})
		expect(record?.run.finishedAt).toEqual(expect.any(String))
	}
})

async function drainWaitUntil(pending: Array<Promise<unknown>>) {
	while (pending.length > 0) await pending.shift()
}

test('a live session reports when it last heard from the daemon', async () => {
	const before = Date.now()
	const { stub, ws } = await connect('ec_last_seen')
	const status = await stub.getStatus()
	expect(status.online).toBe(true)
	expect(Date.parse(status.lastSeenAt ?? '')).toBeGreaterThanOrEqual(
		before - 1_000,
	)
	ws.close()
	await expect
		.poll(() => stub.getStatus())
		.toMatchObject({ online: false, lastSeenAt: null })
})

test('a reconnecting daemon ends the committed runs it no longer holds at once', async () => {
	const ecid = 'ec_reconnect'
	const first = await connect(ecid, {
		status: { acceptingRuns: true, running: 0, maxConcurrent: 3 },
	})
	const commit = async (runId: string) => {
		const dispatching = first.stub.dispatch({
			request: runRequest(runId),
			lease: lease(ecid, runId),
			runRecord: null,
			position: 1,
		})
		const request = await first.next('run.request')
		await first.send('run.accept', { runId }, { re: request.seq })
		expect((await dispatching).outcome).toBe('committed')
		await first.next('run.commit')
	}
	await commit('run_dropped')
	await commit('run_finished_offline')
	await commit('run_still_held')

	const second = await connect(ecid, {
		heldRuns: ['run_still_held'],
		pendingResults: [
			{
				runId: 'run_finished_offline',
				isError: false,
				content: [{ type: 'text', text: 'done' }],
				structuredContent: { result: { slept: 3 } },
			},
		],
	})
	expect(
		await second.stub.awaitResult({ runId: 'run_dropped', waitMs: 0 }),
	).toEqual({ state: 'lost' })
	expect(
		await second.stub.awaitResult({ runId: 'run_finished_offline', waitMs: 0 }),
	).toMatchObject({
		state: 'succeeded',
		result: { structuredContent: { result: { slept: 3 } } },
	})
	expect(
		await second.stub.awaitResult({ runId: 'run_still_held', waitMs: 0 }),
	).toEqual({ state: 'pending' })
	const rows = new Map(
		(await second.stub.listHistory({})).rows.map((row) => [row.runId, row]),
	)
	expect(rows.get('run_dropped')).toMatchObject({
		outcome: 'lost',
		failureReason: 'execution_context_lost',
	})
	expect(rows.get('run_finished_offline')).toMatchObject({
		outcome: 'succeeded',
	})
	await second.send('run.result', {
		runId: 'run_still_held',
		isError: false,
		content: [],
		structuredContent: { result: 1 },
	})
	await second.next('run.result.ack')
	expect(
		await second.stub.awaitResult({ runId: 'run_still_held', waitMs: 1_000 }),
	).toMatchObject({ state: 'succeeded' })
	second.ws.close()
}, 60_000)

test('an older daemon that omits heldRuns leaves committed runs to the alarm', async () => {
	const ecid = 'ec_reconnect_legacy'
	const first = await connect(ecid)
	const dispatching = first.stub.dispatch({
		request: runRequest('run_legacy'),
		lease: lease(ecid, 'run_legacy'),
		runRecord: null,
		position: 1,
	})
	const request = await first.next('run.request')
	await first.send('run.accept', { runId: 'run_legacy' }, { re: request.seq })
	expect((await dispatching).outcome).toBe('committed')
	await first.next('run.commit')

	const second = await connect(ecid)
	expect(
		await second.stub.awaitResult({ runId: 'run_legacy', waitMs: 0 }),
	).toEqual({ state: 'pending' })
	second.ws.close()
}, 60_000)

test('an overdue run with no daemon connected is rechecked before it would be lost', async () => {
	const ecid = 'ec_overdue_recheck'
	const { stub, next, send, ws } = await connect(ecid)
	const dispatching = stub.dispatch({
		request: runRequest('run_overdue'),
		lease: lease(ecid, 'run_overdue'),
		runRecord: null,
		position: 1,
	})
	const request = await next('run.request')
	await send('run.accept', { runId: 'run_overdue' }, { re: request.seq })
	expect((await dispatching).outcome).toBe('committed')
	await next('run.commit')
	ws.close()
	await expect.poll(() => stub.getStatus()).toMatchObject({ online: false })

	await runInDurableObject(stub, async (instance, state) => {
		state.storage.sql.exec(
			`UPDATE runs SET deadline = ? WHERE run_id = 'run_overdue'`,
			Date.now() - 10_000,
		)
		const before = Date.now()
		await instance.alarm()
		const row = state.storage.sql
			.exec<{
				state: string
			}>(`SELECT state FROM runs WHERE run_id = 'run_overdue'`)
			.one()
		expect(row.state).toBe('committed')
		const alarm = await state.storage.getAlarm()
		expect(alarm).not.toBeNull()
		expect(alarm ?? 0).toBeLessThanOrEqual(before + 6_000)
	})
})
