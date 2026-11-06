const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')
const {
	TIMED_OUT,
	parseDuration,
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

test('runWithTimeout resolves the child exit code when it finishes in time', async () => {
	const child = new EventEmitter()
	child.kill = () => {
		throw new Error('should not kill')
	}
	const timers = []
	const resultPromise = runWithTimeout(60_000, 'npm', ['run', 'dist:release'], {
		spawnImpl: () => child,
		setTimeoutImpl: (fn, ms) => {
			timers.push({ fn, ms })
			return timers.length
		},
		clearTimeoutImpl: () => {},
	})
	child.emit('exit', 0, null)
	const result = await resultPromise
	assert.deepEqual(result, { status: 0, timedOut: false, signal: null })
	assert.equal(timers[0]?.ms, 60_000)
})

test('runWithTimeout returns 124 and SIGTERMs a hung child', async () => {
	const kills = []
	const child = new EventEmitter()
	child.kill = (signal) => {
		kills.push(signal)
		if (signal === 'SIGTERM') child.emit('exit', null, 'SIGTERM')
	}
	const pending = []
	const resultPromise = runWithTimeout(25, 'npm', ['run', 'dist:release'], {
		spawnImpl: () => child,
		setTimeoutImpl: (fn, ms) => {
			pending.push({ fn, ms })
			return pending.length
		},
		clearTimeoutImpl: () => {},
		killGraceMs: 5,
	})
	assert.equal(pending[0]?.ms, 25)
	pending[0].fn()
	const result = await resultPromise
	assert.deepEqual(result, {
		status: TIMED_OUT,
		timedOut: true,
		signal: 'SIGTERM',
	})
	assert.deepEqual(kills, ['SIGTERM'])
})
