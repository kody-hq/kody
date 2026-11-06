const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')
const {
	TIMED_OUT,
	parseDuration,
	killProcessTree,
	runWithTimeout,
} = require('../scripts/run-with-timeout.cjs')

test('parseDuration accepts seconds, minutes, and bare integers', () => {
	assert.equal(parseDuration('30'), 30_000)
	assert.equal(parseDuration('30s'), 30_000)
	assert.equal(parseDuration('25m'), 1_500_000)
	assert.equal(parseDuration('1h'), 3_600_000)
	assert.equal(parseDuration('250ms'), 250)
	assert.throws(() => parseDuration('forever'), /Invalid duration/)
})

test('killProcessTree signals the process group on POSIX', () => {
	const kills = []
	killProcessTree(4242, 'SIGTERM', {
		platform: 'linux',
		kill: (target, signal) => kills.push([target, signal]),
	})
	assert.deepEqual(kills, [[-4242, 'SIGTERM']])
})

test('killProcessTree falls back to the pid when the group is gone', () => {
	const kills = []
	killProcessTree(7, 'SIGKILL', {
		platform: 'darwin',
		kill: (target, signal) => {
			kills.push([target, signal])
			if (target < 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
		},
	})
	assert.deepEqual(kills, [
		[-7, 'SIGKILL'],
		[7, 'SIGKILL'],
	])
})

test('killProcessTree uses taskkill /T on Windows', () => {
	const calls = []
	killProcessTree(99, 'SIGTERM', {
		platform: 'win32',
		taskkill: (args) => calls.push(args),
	})
	assert.deepEqual(calls, [['/pid', '99', '/T', '/F']])
})

test('runWithTimeout resolves the child exit code when it finishes in time', async () => {
	const child = new EventEmitter()
	child.pid = 11
	const timers = []
	const resultPromise = runWithTimeout(60_000, 'npm', ['run', 'dist:release'], {
		spawnImpl: () => child,
		setTimeoutImpl: (fn, ms) => {
			timers.push({ fn, ms })
			return timers.length
		},
		clearTimeoutImpl: () => {},
		killTree: () => {
			throw new Error('should not kill')
		},
	})
	child.emit('exit', 0, null)
	const result = await resultPromise
	assert.deepEqual(result, { status: 0, timedOut: false, signal: null })
	assert.equal(timers[0]?.ms, 60_000)
})

test('runWithTimeout SIGKILLs the tree when the direct child exits after SIGTERM', async () => {
	const child = new EventEmitter()
	child.pid = 55
	const kills = []
	const pending = []
	const resultPromise = runWithTimeout(25, 'npm', ['run', 'dist:release'], {
		spawnImpl: (command, args, opts) => {
			assert.equal(opts.detached, true)
			return child
		},
		setTimeoutImpl: (fn, ms) => {
			pending.push({ fn, ms })
			return pending.length
		},
		clearTimeoutImpl: () => {},
		killGraceMs: 5_000,
		killTree: (pid, signal) => {
			kills.push([pid, signal])
			if (signal === 'SIGTERM') child.emit('exit', null, 'SIGTERM')
		},
		platform: 'linux',
	})
	assert.equal(pending[0]?.ms, 25)
	pending[0].fn()
	const result = await resultPromise
	assert.deepEqual(result, {
		status: TIMED_OUT,
		timedOut: true,
		signal: 'SIGTERM',
	})
	// Escalate immediately on child exit so a TERM-resistant descendant dies
	// even though the grace timer has not fired yet.
	assert.deepEqual(kills, [
		[55, 'SIGTERM'],
		[55, 'SIGKILL'],
	])
})

test('runWithTimeout force-kills after grace when the child ignores SIGTERM', async () => {
	const child = new EventEmitter()
	child.pid = 77
	const kills = []
	const pending = []
	const resultPromise = runWithTimeout(10, 'hang', [], {
		spawnImpl: () => child,
		setTimeoutImpl: (fn, ms) => {
			pending.push({ fn, ms })
			return pending.length
		},
		clearTimeoutImpl: () => {},
		killGraceMs: 5,
		killTree: (pid, signal) => {
			kills.push([pid, signal])
			if (signal === 'SIGKILL') child.emit('exit', null, 'SIGKILL')
		},
		platform: 'linux',
	})
	pending[0].fn() // timeout → SIGTERM
	assert.deepEqual(kills, [[77, 'SIGTERM']])
	assert.equal(pending[1]?.ms, 5)
	pending[1].fn() // grace → SIGKILL
	const result = await resultPromise
	assert.deepEqual(result, {
		status: TIMED_OUT,
		timedOut: true,
		signal: 'SIGKILL',
	})
	assert.deepEqual(kills, [
		[77, 'SIGTERM'],
		[77, 'SIGKILL'],
	])
})
