import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	isRemoteDaemonCommand,
	runRemoteDaemonCommand,
} from '../src/execution-context/daemon-remote.ts'

const apiUrl = 'https://api.kody.test'

function recorder(responses: Record<string, unknown>) {
	const calls: Array<{ method: string; path: string; body: unknown }> = []
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		const parsed = new URL(String(url))
		const key = `${init?.method ?? 'GET'} ${parsed.pathname}${parsed.search}`
		calls.push({
			method: init?.method ?? 'GET',
			path: `${parsed.pathname}${parsed.search}`,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		})
		const response = responses[key]
		if (response === undefined)
			return Response.json(
				{
					error: { code: 'context_offline', message: 'build-box is offline.' },
				},
				{ status: 409 },
			)
		return Response.json(response)
	}) as typeof fetch
	return { calls, fetchFn }
}

async function run(
	sub: string,
	responses: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	const { calls, fetchFn } = recorder(responses)
	let out = ''
	const code = await runRemoteDaemonCommand({
		sub,
		args: [],
		apiUrl,
		fetchFn,
		token: async () => 'kody_at_test',
		context: 'build-box',
		write: (text) => {
			out += text
		},
		...extra,
	})
	return { code, out, calls }
}

test('pause, resume and config always go through Kody; live commands only for another machine or --remote', () => {
	for (const sub of ['pause', 'resume', 'config'])
		assert.equal(isRemoteDaemonCommand({ sub, apiUrl }), true, sub)
	for (const sub of ['status', 'restart', 'update', 'logs']) {
		assert.equal(isRemoteDaemonCommand({ sub, apiUrl }), false, sub)
		assert.equal(isRemoteDaemonCommand({ sub, apiUrl, remote: true }), true)
		assert.equal(
			isRemoteDaemonCommand({ sub, apiUrl, context: 'not-on-this-machine' }),
			true,
		)
	}
	for (const sub of ['install', 'start', 'stop', 'uninstall', undefined])
		assert.equal(
			isRemoteDaemonCommand({ sub, apiUrl, remote: true, context: 'x' }),
			false,
		)
})

test('kody daemon pause sends the reason and cancel flag and prints the server note', async () => {
	const { code, out, calls } = await run(
		'pause',
		{
			'POST /v1/execution-contexts/build-box/pause': {
				name: 'build-box',
				alreadyPaused: false,
				note: 'Chains skip it until it is resumed.',
			},
		},
		{ reason: 'disk full', cancelRuns: true },
	)
	assert.equal(code, 0)
	assert.deepEqual(calls[0]!.body, { reason: 'disk full', cancel_runs: true })
	assert.equal(out, 'Paused: build-box. Chains skip it until it is resumed.\n')
})

test('remote logs are capped at 500 lines and print one line per entry', async () => {
	await assert.rejects(run('logs', {}, { lines: '501' }), /1 to 500/)
	const { out, calls } = await run(
		'logs',
		{
			'GET /v1/execution-contexts/build-box/daemon/logs?lines=2': {
				lines: ['one', 'two'],
			},
		},
		{ lines: '2' },
	)
	assert.equal(
		calls[0]!.path,
		'/v1/execution-contexts/build-box/daemon/logs?lines=2',
	)
	assert.equal(out, 'one\ntwo\n')
})

test('an offline context fails with the server message instead of hanging', async () => {
	await assert.rejects(run('restart', {}), /build-box is offline/)
})

test('status shows the pause and how to resume it', async () => {
	const { out } = await run('status', {
		'GET /v1/execution-contexts/build-box/daemon': {
			id: 'ec_1',
			name: 'build-box',
			state: 'paused',
			online: true,
			paused: {
				at: '2026-11-05T00:00:00.000Z',
				by: 'kent',
				reason: 'disk full',
			},
			daemon: {
				version: '3.29.0',
				service: 'systemd',
				autoUpdate: 'on',
				runs: 0,
				maxConcurrent: 2,
			},
		},
	})
	assert.match(out, /^build-box: paused$/m)
	assert.match(
		out,
		/by @kent: disk full\. Resume with: kody daemon resume --context build-box/,
	)
	assert.match(
		out,
		/kody 3\.29\.0, systemd service, auto-update on, 0\/2 run\(s\)/,
	)
})

test('config set validates its value before calling Kody', async () => {
	const { calls, fetchFn } = recorder({
		'PATCH /v1/execution-contexts/build-box/daemon/config': {
			name: 'build-box',
			maxConcurrent: 3,
		},
	})
	const base = {
		sub: 'config',
		apiUrl,
		fetchFn,
		token: async () => 'kody_at_test',
		context: 'build-box',
		write: () => {},
	}
	await assert.rejects(
		runRemoteDaemonCommand({ ...base, args: ['set', 'max-concurrent', '9'] }),
		/1 to 8/,
	)
	await runRemoteDaemonCommand({
		...base,
		args: ['set', 'max-concurrent', '3'],
	})
	assert.deepEqual(calls.at(-1)!.body, { max_concurrent: 3 })
})
