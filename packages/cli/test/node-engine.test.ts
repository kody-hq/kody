import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertLocalExecuteNodeEngine } from '../src/node-engine.js'

test('assertLocalExecuteNodeEngine accepts Node 22.19 and newer', () => {
	for (const version of ['22.19.0', 'v22.21.1', '23.0.0', '24.1.0', '26']) {
		assert.doesNotThrow(() => assertLocalExecuteNodeEngine(version), version)
	}
	assert.doesNotThrow(() => assertLocalExecuteNodeEngine(process.versions.node))
})

test('assertLocalExecuteNodeEngine names Node 22.19 and workerd before any runtime start', () => {
	assert.throws(
		() => assertLocalExecuteNodeEngine('22.18.9'),
		/execute --local needs Node\.js 22\.19 or newer \(this process is v22\.18\.9\)[\s\S]*workerd/,
	)
	assert.throws(
		() => assertLocalExecuteNodeEngine('20.19.2'),
		/needs Node\.js 22\.19 or newer \(this process is v20\.19\.2\)/,
	)
	assert.throws(
		() => assertLocalExecuteNodeEngine('not-a-version'),
		/this process is vnot-a-version/,
	)
})
