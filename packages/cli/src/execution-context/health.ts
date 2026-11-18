import { Worker } from 'node:worker_threads'
import type { DaemonConnection } from './daemon.js'

/** How often a running daemon rewrites its state file. */
export const healthWriteMs = 30_000
/** A state file older than this means the daemon process is not running its loop. */
const staleStateMs = 3 * healthWriteMs
/** Pings go out every 30s with a 10s deadline, so a live link is heard well within this. */
const defaultMaxHeartbeatAgeMs = 120_000

export type ConnectionState = {
	connected: boolean
	since: string
	lastHeardAt: string | null
	updatedAt: string
}

export function connectionState(
	connection: DaemonConnection,
	now = Date.now(),
): ConnectionState {
	return {
		connected: connection.connected,
		since: new Date(connection.since).toISOString(),
		lastHeardAt:
			connection.lastHeardAt === null
				? null
				: new Date(connection.lastHeardAt).toISOString(),
		updatedAt: new Date(now).toISOString(),
	}
}

export type DaemonHealth = {
	healthy: boolean
	reason:
		| 'ok'
		| 'not-running'
		| 'no-health-data'
		| 'stalled'
		| 'disconnected'
		| 'heartbeat-stale'
	message: string
	pid: number | null
	version: string | null
	connected: boolean
	lastHeartbeatAt: string | null
	lastHeartbeatAgeSeconds: number | null
	maxHeartbeatAgeSeconds: number
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))

/** Judges one daemon from the state file it keeps while it runs. */
export function daemonHealth(input: {
	state: {
		pid: number
		version: string
		startedAt: string
		connection?: ConnectionState
	} | null
	alive: (pid: number) => boolean
	maxHeartbeatAgeMs?: number
	now?: number
}): DaemonHealth {
	const now = input.now ?? Date.now()
	const maxAgeMs = input.maxHeartbeatAgeMs ?? defaultMaxHeartbeatAgeMs
	const { state } = input
	const connection = state?.connection
	const heardMs = connection?.lastHeardAt
		? now - Date.parse(connection.lastHeardAt)
		: null
	const base = {
		pid: state?.pid ?? null,
		version: state?.version ?? null,
		connected: connection?.connected ?? false,
		lastHeartbeatAt: connection?.lastHeardAt ?? null,
		lastHeartbeatAgeSeconds: heardMs === null ? null : seconds(heardMs),
		maxHeartbeatAgeSeconds: seconds(maxAgeMs),
	}
	const bad = (reason: DaemonHealth['reason'], message: string) => ({
		...base,
		healthy: false,
		reason,
		message,
	})
	if (!state || !input.alive(state.pid)) {
		return bad('not-running', 'No kody daemon is running for this context.')
	}
	if (!connection) {
		return bad(
			'no-health-data',
			`The running daemon (kody ${state.version}) does not report its connection. Update it with: kody update`,
		)
	}
	const stateAgeMs = now - Date.parse(connection.updatedAt)
	if (stateAgeMs > staleStateMs) {
		return bad(
			'stalled',
			`The daemon process (pid ${state.pid}) has not reported for ${seconds(stateAgeMs)}s: it is frozen or stuck. Restart it.`,
		)
	}
	// A daemon that just started or is mid-reconnect gets the same grace.
	const quietMs = heardMs ?? now - Date.parse(state.startedAt)
	if (quietMs > maxAgeMs) {
		return connection.connected
			? bad(
					'heartbeat-stale',
					`Connected, but Kody was last heard ${seconds(quietMs)}s ago.`,
				)
			: bad(
					'disconnected',
					`Not connected to Kody for ${seconds(quietMs)}s (reconnecting).`,
				)
	}
	return {
		...base,
		healthy: true,
		reason: 'ok',
		message: connection.connected
			? `Connected. Kody was last heard ${seconds(quietMs)}s ago.`
			: `Reconnecting. Kody was last heard ${seconds(quietMs)}s ago.`,
	}
}

const watchdogSource = `
const { workerData } = require('node:worker_threads')
const beats = new Int32Array(workerData.beats)
let seen = Atomics.load(beats, 0)
let missed = 0
const timer = setInterval(() => {
	const now = Atomics.load(beats, 0)
	if (now !== seen) {
		seen = now
		missed = 0
		return
	}
	missed += 1
	if (missed < workerData.ticks) return
	try {
		require('node:fs').writeSync(2, workerData.message)
	} catch {}
	clearInterval(timer)
	try {
		process.kill(process.pid, 'SIGKILL')
	} catch {}
}, workerData.tickMs)
`

/**
 * Kills this process when its event loop stops turning for `stallMs`: a
 * wedged daemon holds its lock and looks alive to a supervisor, so nothing
 * else would restart it. The stall is counted in the watchdog thread's own
 * ticks, so a sleeping or suspended machine never trips it. The kernel
 * ignores a SIGKILL that PID 1 of a container sends itself, so a container
 * needs an init process (`init: true`) or a healthcheck for this case.
 */
export function startLoopWatchdog(
	input: { stallMs?: number; tickMs?: number } = {},
) {
	const tickMs = input.tickMs ?? 5_000
	const stallMs = input.stallMs ?? 5 * 60_000
	const shared = new SharedArrayBuffer(4)
	const beats = new Int32Array(shared)
	const worker = new Worker(watchdogSource, {
		eval: true,
		// No inherited loaders or flags: the watchdog must not depend on the main thread.
		execArgv: [],
		workerData: {
			beats: shared,
			tickMs,
			ticks: Math.max(1, Math.ceil(stallMs / tickMs)),
			message: `kody daemon: the event loop has been stuck for ${Math.round(stallMs / 1000)}s. Exiting so the service manager or container restarts kody.\n`,
		},
	})
	worker.unref()
	// A watchdog that cannot run must not take the daemon down.
	worker.on('error', () => {})
	const beat = setInterval(() => Atomics.add(beats, 0, 1), tickMs)
	beat.unref()
	return () => {
		clearInterval(beat)
		void worker.terminate()
	}
}
