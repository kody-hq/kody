const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	updateReadinessTransitions,
	updateCheckTransitions,
} = require('../updates.cjs')
const { executionOperationTransitions } = require('../execution.cjs')
test('packaged frozen tables validate against the shared primitive and pin their graphs', async () => {
	const { defineStateMachine } =
		await import('../../shared/src/state-machine.ts')
	for (const [name, initial, transitions, expected] of [
		[
			'readiness',
			'waiting',
			updateReadinessTransitions,
			{
				waiting: ['downloaded'],
				downloaded: ['downloaded', 'installing'],
				installing: ['downloaded', 'installing'],
			},
		],
		[
			'checking',
			'idle',
			updateCheckTransitions,
			{ idle: ['checking'], checking: ['idle'] },
		],
		[
			'execution',
			'idle',
			executionOperationTransitions,
			{
				idle: ['running', 'error'],
				running: ['idle', 'running', 'error'],
				error: ['idle', 'running', 'error'],
			},
		],
	]) {
		assert.equal(Object.isFrozen(transitions), true)
		assert.equal(Object.values(transitions).every(Object.isFrozen), true)
		assert.deepEqual(
			defineStateMachine({ name, description: name, initial, transitions })
				.transitions,
			expected,
		)
	}
})
