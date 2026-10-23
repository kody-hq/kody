import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertLocalExecuteNodeEngine } from '../src/node-engine.js'

test('assertLocalExecuteNodeEngine accepts Node 22 and newer', () => {
	assert.doesNotThrow(() => assertLocalExecuteNodeEngine('22.0.0'))
	assert.doesNotThrow(() => assertLocalExecuteNodeEngine('24.1.0'))
	assert.doesNotThrow(() => assertLocalExecuteNodeEngine(process.versions.node))
})

test('assertLocalExecuteNodeEngine names Node 22 and workerd before any runtime start', () => {
	assert.throws(
		() => assertLocalExecuteNodeEngine('20.19.2'),
		/execute --local needs Node\.js 22 or newer \(this process is v20\.19\.2\)[\s\S]*workerd/,
	)
	assert.throws(
		() => assertLocalExecuteNodeEngine('not-a-version'),
		/this process is vnot-a-version/,
	)
})
