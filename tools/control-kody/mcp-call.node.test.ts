import { expect, test } from 'vitest'

import { executeAppMcp } from './mcp-call.ts'
import type { McpCallConnection } from './mcp-tool-result.ts'

function fakeConnect(results: Array<Record<string, unknown> | Error>) {
	const calls: Array<Record<string, unknown>> = []
	const connect = async (): Promise<McpCallConnection> => ({
		cookieHeader: 'session=1',
		client: {
			async callTool(params) {
				calls.push(params.arguments)
				const next = results.shift()
				if (next instanceof Error) throw next
				return { content: [], structuredContent: next }
			},
		},
	})
	return { calls, connect }
}

const base = {
	origin: 'http://localhost:3742',
	email: 'me@example.com',
	password: 'pw',
	code: 'export default () => 1',
	params: { a: 1 },
	followIntervalMs: 0,
}

test('execute follows an in-progress run with its idempotency key until it finishes', async () => {
	const { calls, connect } = fakeConnect([
		{ inProgress: true, runId: 'run_1', idempotencyKey: 'key_1' },
		{ inProgress: true, runId: 'run_1', idempotencyKey: 'key_1' },
		{ result: { saved: 2 } },
	])
	const report = await executeAppMcp({ ...base, connect })
	expect(report.result).toEqual({ saved: 2 })
	expect(calls).toEqual([
		{ code: base.code, params: base.params },
		{ code: base.code, params: base.params, idempotencyKey: 'key_1' },
		{ code: base.code, params: base.params, idempotencyKey: 'key_1' },
	])
})

test('execute passes --idempotency-key and returns the handle when following is off', async () => {
	const { calls, connect } = fakeConnect([
		{ inProgress: true, runId: 'run_2', idempotencyKey: 'key_2' },
	])
	const report = await executeAppMcp({
		...base,
		idempotencyKey: 'key_2',
		followTimeoutMs: 0,
		connect,
	})
	expect(report.result).toEqual({
		inProgress: true,
		runId: 'run_2',
		idempotencyKey: 'key_2',
	})
	expect(calls).toEqual([
		{ code: base.code, params: base.params, idempotencyKey: 'key_2' },
	])
})

test('execute does not follow a finished module result that looks like a handle', async () => {
	const finished = { inProgress: true, idempotencyKey: 'business-key' }
	const { calls, connect } = fakeConnect([{ result: finished }])
	const report = await executeAppMcp({ ...base, connect })
	expect(report.result).toEqual(finished)
	expect(calls).toHaveLength(1)
})

test('execute names the idempotency key when re-reading a run fails', async () => {
	const { connect } = fakeConnect([
		{ inProgress: true, runId: 'run_3', idempotencyKey: 'key_3' },
		new Error('socket hang up'),
	])
	await expect(executeAppMcp({ ...base, connect })).rejects.toThrow(
		/resume with --idempotency-key key_3: socket hang up/,
	)
})
