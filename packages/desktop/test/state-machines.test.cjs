const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	updateReadinessTransitions,
	updateCheckTransitions,
} = require('../updates.cjs')
const { executionOperationTransitions } = require('../execution.cjs')

test('packaged frozen tables reject illegal transitions', async () => {
	const { defineStateMachine } =
		await import('../../shared/src/state-machine.ts')
	for (const transitions of [
		updateReadinessTransitions,
		updateCheckTransitions,
		executionOperationTransitions,
	]) {
		assert.equal(Object.isFrozen(transitions), true)
		assert.equal(Object.values(transitions).every(Object.isFrozen), true)
	}
	const readiness = defineStateMachine({
		name: 'readiness',
		description: 'readiness',
		initial: 'waiting',
		transitions: updateReadinessTransitions,
	})
	assert.equal(readiness.can('waiting', 'downloaded'), true)
	assert.equal(readiness.can('waiting', 'installing'), false)
	assert.equal(readiness.can('installing', 'waiting'), false)
	const checking = defineStateMachine({
		name: 'checking',
		description: 'checking',
		initial: 'idle',
		transitions: updateCheckTransitions,
	})
	assert.equal(checking.can('idle', 'checking'), true)
	assert.equal(checking.can('checking', 'idle'), true)
	assert.equal(checking.can('idle', 'idle'), false)
	const execution = defineStateMachine({
		name: 'execution',
		description: 'execution',
		initial: 'idle',
		transitions: executionOperationTransitions,
	})
	assert.equal(execution.can('error', 'idle'), true)
	assert.equal(execution.can('error', 'running'), true)
	assert.equal(execution.can('idle', 'idle'), false)
})
