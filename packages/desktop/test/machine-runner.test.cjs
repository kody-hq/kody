const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	existingRegistration,
	runnerView,
	shouldAdopt,
} = require('../machine-runner.cjs')

test('a CLI service is adopted and controlled instead of a second runner', () => {
	const status = {
		ecid: 'ec_mac',
		contextName: 'Kent Mac',
		installed: true,
		manager: 'launchd',
		running: true,
		runningVersion: '3.17.0',
		runner: { pid: 42, launcher: 'launchd', version: '3.17.0' },
	}
	assert.ok(shouldAdopt(status))
	assert.deepEqual(existingRegistration(status), {
		ecid: 'ec_mac',
		name: 'Kent Mac',
	})
	const view = runnerView({ status, ownRunning: false, hasRegistration: true })
	assert.equal(view.mode, 'service')
	assert.equal(view.label, 'Runner running: CLI service (launchd), kody 3.17.0')
	assert.deepEqual(
		[view.canStart, view.canStop, view.canRestart],
		[false, true, true],
	)
	const stopped = runnerView({
		status: { ...status, running: false, runner: null },
		ownRunning: false,
		hasRegistration: true,
	})
	assert.equal(stopped.canStart, true)
})

test('a terminal daemon is shown and can be stopped, never doubled', () => {
	const status = {
		ecid: 'ec_box',
		installed: false,
		runner: { pid: 7, launcher: 'terminal', version: '3.16.1' },
	}
	assert.ok(shouldAdopt(status))
	const view = runnerView({ status, ownRunning: false, hasRegistration: true })
	assert.equal(view.mode, 'external')
	assert.match(view.label, /terminal \(pid 7\), kody 3\.16\.1/)
	assert.equal(view.canStart, false)
	assert.equal(view.canStop, true)
})

test('with no service the app owns the runner as before', () => {
	const status = {
		ecid: 'ec_box',
		installed: false,
		runner: null,
		contexts: [],
	}
	assert.equal(shouldAdopt(status), false)
	assert.equal(
		runnerView({ status, ownRunning: false, hasRegistration: true }).canStart,
		true,
	)
	assert.equal(
		runnerView({ status, ownRunning: true, hasRegistration: true }).mode,
		'desktop',
	)
	assert.equal(
		runnerView({ status: null, ownRunning: false, hasRegistration: false })
			.canStart,
		false,
	)
})

test('an existing registration is offered instead of registering again', () => {
	assert.deepEqual(
		existingRegistration({
			ecid: null,
			contexts: [{ ecid: 'ec_first', name: 'Laptop' }],
		}),
		{ ecid: 'ec_first', name: 'Laptop' },
	)
	assert.equal(existingRegistration({ ecid: null, contexts: [] }), null)
	assert.equal(existingRegistration(null), null)
})

test('a stopped service with a terminal daemon holding the lock shows that daemon', () => {
	const view = runnerView({
		status: {
			installed: true,
			manager: 'launchd',
			running: false,
			runner: { pid: 7, launcher: 'terminal', version: '3.17.0' },
		},
		ownRunning: false,
		hasRegistration: true,
	})
	assert.equal(view.mode, 'external')
	assert.deepEqual([view.canStart, view.canStop], [false, true])
})
