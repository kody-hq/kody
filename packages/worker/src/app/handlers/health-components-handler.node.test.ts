import { expect, test } from 'vitest'
import {
	collectHealthComponents,
	createHealthComponentsHandler,
	healthComponentIds,
	type HealthComponentsReport,
} from '#app/handlers/health-components.ts'
import { fleetExecuteLastSuccessKvKey } from '#worker/execute-health-heartbeat.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

function d1(first: () => Promise<unknown>, onPrepare = () => {}) {
	return {
		prepare: () => {
			onPrepare()
			return { first }
		},
	} as unknown as D1Database
}

function kv(get: (key: string) => Promise<unknown>) {
	return { get } as unknown as KVNamespace
}

const healthyQuery = async () => ({ 1: 1 })

function createHealthyBindings(overrides: Record<string, unknown> = {}) {
	return {
		APP_COMMIT_SHA: 'abc123' as string | undefined,
		APP_DB: d1(healthyQuery),
		AUDIT_DB: d1(healthyQuery),
		OAUTH_KV: kv(async () => null),
		COMMUNITY_ASSETS: { head: async () => null } as unknown as R2Bucket,
		...overrides,
	}
}

function component(report: HealthComponentsReport, id: string) {
	return report.components.find((entry) => entry.id === id)
}

function fetchComponents(
	handler: ReturnType<typeof createHealthComponentsHandler>,
) {
	return handler()
}

test('collectHealthComponents reports healthy, failed, and unavailable bindings', async () => {
	const healthy = await collectHealthComponents(createHealthyBindings())
	expect(healthy.ok).toBe(true)
	expect(healthy.commitSha).toBe('abc123')
	expect(healthy.components.map((entry) => entry.id)).toEqual([
		...healthComponentIds,
	])
	expect(healthy.executeEvidence).toEqual({ lastSuccessAt: null })
	for (const entry of healthy.components) {
		expect(entry.ok).toBe(true)
		expect(entry.latencyMs).toBeGreaterThanOrEqual(0)
		expect(entry.error).toBeUndefined()
	}

	const lastSuccessAt = '2026-09-07T17:00:00.000Z'
	const evidenced = await collectHealthComponents(
		createHealthyBindings({
			BUNDLE_ARTIFACTS_KV: kv(async (key) =>
				key === fleetExecuteLastSuccessKvKey
					? JSON.stringify({ at: Date.parse(lastSuccessAt) })
					: null,
			),
		}),
	)
	expect(evidenced.ok).toBe(true)
	expect(evidenced.executeEvidence).toEqual({ lastSuccessAt })

	consoleWarn.mockImplementation(() => {})
	const failed = await collectHealthComponents(
		createHealthyBindings({
			APP_DB: d1(async () => {
				throw new Error('database is unavailable')
			}),
		}),
	)
	expect(failed.ok).toBe(false)
	expect(component(failed, 'app_db')).toMatchObject({
		ok: false,
		error: 'error',
	})
	expect(
		failed.components.filter((entry) => entry.id !== 'app_db' && !entry.ok),
	).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'health-component-failed',
		expect.any(String),
	)

	const missing = await collectHealthComponents({ APP_COMMIT_SHA: undefined })
	expect(missing.ok).toBe(false)
	expect(missing.commitSha).toBeNull()
	for (const entry of missing.components) {
		expect(entry).toMatchObject({ ok: false, error: 'unavailable' })
	}
})

test('D1 checks retry transient blips (including hangs) but fail fast on other errors', async () => {
	const networkLost = () => {
		throw new Error('D1_ERROR: Network connection lost.')
	}
	const cases: Array<{
		name: string
		binding: 'APP_DB' | 'AUDIT_DB'
		attempt: (n: number) => Promise<unknown>
		attempts: number
		ok: boolean
	}> = [
		{
			name: 'one network blip recovers',
			binding: 'AUDIT_DB',
			attempt: async (n) => (n === 1 ? networkLost() : { 1: 1 }),
			attempts: 2,
			ok: true,
		},
		{
			name: 'a hung first attempt recovers',
			binding: 'AUDIT_DB',
			attempt: async (n) => (n === 1 ? await new Promise(() => {}) : { 1: 1 }),
			attempts: 2,
			ok: true,
		},
		{
			name: 'persistent network loss gives up after three tries',
			binding: 'AUDIT_DB',
			attempt: async () => networkLost(),
			attempts: 3,
			ok: false,
		},
		{
			name: 'non-transient errors fail fast',
			binding: 'APP_DB',
			attempt: async () => {
				throw new Error('no such table: users')
			},
			attempts: 1,
			ok: false,
		},
	]
	// Recovering cases run first, before failure warnings are allowed.
	for (const { name, binding, attempt, attempts, ok } of cases) {
		if (!ok) consoleWarn.mockImplementation(() => {})
		let count = 0
		const report = await collectHealthComponents(
			createHealthyBindings({ [binding]: d1(() => attempt(++count)) }),
		)
		const entry = component(
			report,
			binding === 'APP_DB' ? 'app_db' : 'audit_db',
		)
		expect({ name, count, ok: report.ok, entry }).toMatchObject({
			name,
			count: attempts,
			ok,
			entry: ok ? { ok: true } : { ok: false, error: 'error' },
		})
	}
})

test('health components handler memoizes, coalesces in-flight work, and returns 503 on failure', async () => {
	let prepareCalls = 0
	const handler = createHealthComponentsHandler(
		createHealthyBindings({ APP_DB: d1(healthyQuery, () => prepareCalls++) }),
	)
	const first = await fetchComponents(handler)
	const second = await fetchComponents(handler)
	expect(first.status).toBe(200)
	expect(first.headers.get('Cache-Control')).toBe('no-store')
	expect(second.status).toBe(200)
	expect(prepareCalls).toBe(1)
	const body = (await first.json()) as HealthComponentsReport
	expect(body.ok).toBe(true)
	expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(body.executeEvidence.lastSuccessAt).toBeNull()

	let releaseFirst = () => {}
	const gate = new Promise<void>((resolve) => (releaseFirst = resolve))
	prepareCalls = 0
	const concurrentHandler = createHealthComponentsHandler(
		createHealthyBindings({
			APP_DB: d1(
				async () => {
					await gate
					return { 1: 1 }
				},
				() => prepareCalls++,
			),
		}),
	)
	const inFlight = [
		fetchComponents(concurrentHandler),
		fetchComponents(concurrentHandler),
	]
	releaseFirst()
	const statuses = (await Promise.all(inFlight)).map((r) => r.status)
	expect(statuses).toEqual([200, 200])
	expect(prepareCalls).toBe(1)

	consoleWarn.mockImplementation(() => {})
	const response = await fetchComponents(
		createHealthComponentsHandler(
			createHealthyBindings({
				OAUTH_KV: kv(async () => {
					throw new Error('kv is down')
				}),
			}),
		),
	)
	expect(response.status).toBe(503)
	const failedBody = (await response.json()) as HealthComponentsReport
	expect(failedBody.ok).toBe(false)
	expect(component(failedBody, 'kv')).toMatchObject({
		ok: false,
		error: 'error',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'health-component-failed',
		expect.any(String),
	)
})

test('hung execute-evidence KV read fails open as unknown and does not block components', async () => {
	consoleWarn.mockImplementation(() => {})
	const report = await collectHealthComponents(
		createHealthyBindings({
			BUNDLE_ARTIFACTS_KV: kv(async () => await new Promise(() => {})),
		}),
	)
	expect(report.ok).toBe(true)
	expect(report.executeEvidence).toEqual({ lastSuccessAt: null })
	expect(consoleWarn).toHaveBeenCalledWith('health-execute-evidence-timeout')
})
