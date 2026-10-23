import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTargetFlag, resolveTarget, targetEnvVar } from '../src/target.js'

test('resolveTarget precedence: flag > env > default', () => {
	assert.equal(resolveTarget({ command: 'dev', env: {} }), 'mock')
	assert.equal(resolveTarget({ command: 'execute', env: {} }), 'prod')
	assert.equal(
		resolveTarget({ command: 'dev', env: { [targetEnvVar]: 'prod' } }),
		'prod',
	)
	assert.equal(
		resolveTarget({
			command: 'execute',
			flag: 'mock',
			env: { [targetEnvVar]: 'prod' },
		}),
		'mock',
	)
})

test('parseTargetFlag rejects unknown values', () => {
	assert.equal(parseTargetFlag('PROD'), 'prod')
	assert.throws(() => parseTargetFlag('staging'), /prod.*or.*mock/)
})
