import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	defaultSimulatedStorageLatencyMs,
	localUsernameFor,
	parseDevSimulation,
} from '../src/dev/local-kody.ts'

test('no simulation flags means no simulation', () => {
	assert.equal(parseDevSimulation({}), undefined)
})

test('--simulate-latency uses the default latency unless --latency-ms is set', () => {
	assert.deepEqual(parseDevSimulation({ simulateLatency: true }), {
		storageLatencyMs: defaultSimulatedStorageLatencyMs,
	})
	assert.deepEqual(parseDevSimulation({ latencyMs: '80' }), {
		storageLatencyMs: 80,
	})
	assert.throws(() => parseDevSimulation({ latencyMs: 'fast' }), /--latency-ms/)
})

test('--cold and --clock map to their simulations', () => {
	const now = Date.parse('2026-01-01T00:00:00.000Z')
	assert.deepEqual(
		parseDevSimulation({ cold: true, clock: '2026-01-02T00:00:00.000Z', now }),
		{ coldIsolates: true, clockOffsetMs: 86_400_000 },
	)
	assert.deepEqual(parseDevSimulation({ clock: '-5000', now }), {
		clockOffsetMs: -5000,
	})
	assert.throws(() => parseDevSimulation({ clock: 'next tuesday' }), /--clock/)
})

test('the local account name comes from the package scope', () => {
	assert.equal(localUsernameFor({ name: '@Acme/app' }), 'acme')
	assert.equal(localUsernameFor({ name: 'app' }), 'dev')
})
