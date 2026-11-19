import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { daemonHealth } from '../src/execution-context/health.js'

const now = Date.parse('2026-11-16T12:00:00.000Z')
const ago = (ms: number) => new Date(now - ms).toISOString()

function health(
	connection: {
		connected: boolean
		lastHeardMs: number | null
		updatedMs?: number
	} | null,
	options: { alive?: boolean; startedMs?: number; maxAgeMs?: number } = {},
) {
	return daemonHealth({
		state: {
			pid: 42,
			version: '9.9.9',
			startedAt: ago(options.startedMs ?? 3_600_000),
			...(connection
				? {
						connection: {
							connected: connection.connected,
							since: ago(600_000),
							lastHeardAt:
								connection.lastHeardMs === null
									? null
									: ago(connection.lastHeardMs),
							updatedAt: ago(connection.updatedMs ?? 5_000),
						},
					}
				: {}),
		},
		alive: () => options.alive ?? true,
		now,
		...(options.maxAgeMs === undefined
			? {}
			: { maxHeartbeatAgeMs: options.maxAgeMs }),
	})
}

test('a connected daemon that heard Kody recently is healthy', () => {
	const result = health({ connected: true, lastHeardMs: 12_000 })
	assert.equal(result.healthy, true)
	assert.equal(result.reason, 'ok')
	assert.equal(result.lastHeartbeatAgeSeconds, 12)
})

test('a brief reconnect stays healthy until the heartbeat age runs out', () => {
	assert.equal(health({ connected: false, lastHeardMs: 40_000 }).healthy, true)
	const result = health({ connected: false, lastHeardMs: 300_000 })
	assert.equal(result.healthy, false)
	assert.equal(result.reason, 'disconnected')
})

test('a connected daemon that has not heard Kody within the limit is unhealthy', () => {
	const result = health({ connected: true, lastHeardMs: 300_000 })
	assert.equal(result.healthy, false)
	assert.equal(result.reason, 'heartbeat-stale')
	assert.equal(
		health({ connected: true, lastHeardMs: 40_000 }, { maxAgeMs: 30_000 })
			.reason,
		'heartbeat-stale',
	)
})

test('a daemon that stopped rewriting its state is stalled, whatever it last said', () => {
	const result = health({
		connected: true,
		lastHeardMs: 601_000,
		updatedMs: 600_000,
	})
	assert.equal(result.healthy, false)
	assert.equal(result.reason, 'stalled')
})

test('no daemon, a dead pid, and a daemon without health data are unhealthy', () => {
	assert.equal(
		daemonHealth({ state: null, alive: () => true }).reason,
		'not-running',
	)
	assert.equal(
		health({ connected: true, lastHeardMs: 1_000 }, { alive: false }).reason,
		'not-running',
	)
	assert.equal(health(null).reason, 'no-health-data')
})

test('a daemon that just started gets the heartbeat grace before its first welcome', () => {
	assert.equal(
		health({ connected: false, lastHeardMs: null }, { startedMs: 20_000 })
			.healthy,
		true,
	)
	assert.equal(
		health({ connected: false, lastHeardMs: null }, { startedMs: 900_000 })
			.reason,
		'disconnected',
	)
})

test('the loop watchdog kills a process whose event loop is stuck', async () => {
	const script = `
import { startLoopWatchdog } from './src/execution-context/health.ts'
startLoopWatchdog({ stallMs: 300, tickMs: 50 })
setTimeout(() => { for (;;) {} }, 1000)
`
	const child = spawn(
		process.execPath,
		['--import', 'tsx', '--input-type=module', '-e', script],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	)
	let stderr = ''
	child.stderr!.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf8')
	})
	const exit = await new Promise<{
		code: number | null
		signal: string | null
	}>((resolve) => {
		const giveUp = setTimeout(() => child.kill('SIGKILL'), 30_000)
		child.once('exit', (code, signal) => {
			clearTimeout(giveUp)
			resolve({ code, signal })
		})
	})
	assert.match(stderr, /event loop has been stuck/)
	assert.notEqual(exit.code, 0)
})

test('the loop watchdog leaves a busy but turning process alone', async () => {
	const script = `
import { startLoopWatchdog } from './src/execution-context/health.ts'
const stop = startLoopWatchdog({ stallMs: 300, tickMs: 50 })
const until = Date.now() + 1500
const spin = () => {
	const end = Date.now() + 100
	while (Date.now() < end) {}
	if (Date.now() < until) setTimeout(spin, 60)
	else { stop(); console.log('done') }
}
spin()
`
	const child = spawn(
		process.execPath,
		['--import', 'tsx', '--input-type=module', '-e', script],
		{ stdio: ['ignore', 'pipe', 'inherit'] },
	)
	let stdout = ''
	child.stdout!.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8')
	})
	const code = await new Promise((resolve) => child.once('exit', resolve))
	assert.equal(code, 0)
	assert.match(stdout, /done/)
})
