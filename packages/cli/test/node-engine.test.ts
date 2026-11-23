import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	appCheckNodeEngine,
	assertNodeEngine,
	localExecuteNodeEngine,
} from '../src/node-engine.js'

test('assertNodeEngine accepts Node 22.19 and newer', () => {
	for (const version of ['22.19.0', 'v22.21.1', '23.0.0', '24.1.0', '26']) {
		assert.doesNotThrow(
			() => assertNodeEngine(localExecuteNodeEngine, version),
			version,
		)
	}
	assert.doesNotThrow(() => assertNodeEngine(localExecuteNodeEngine))
})

test('assertNodeEngine names Node 22.19 and the command before any runtime start', () => {
	assert.throws(
		() => assertNodeEngine(localExecuteNodeEngine, '22.18.9'),
		/execute --local needs Node\.js 22\.19 or newer \(this process is v22\.18\.9\)\. Local execute runs your module in workerd\./,
	)
	assert.throws(
		() => assertNodeEngine(appCheckNodeEngine, '20.19.2'),
		/kody app check needs Node\.js 22\.19 or newer \(this process is v20\.19\.2\)\. The check runs Lighthouse 13\./,
	)
	assert.throws(
		() => assertNodeEngine(localExecuteNodeEngine, 'not-a-version'),
		/needs Node\.js 22\.19 or newer/,
	)
})
