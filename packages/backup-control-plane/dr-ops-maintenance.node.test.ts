import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { environment } from './backup-control-plane-test-support.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'
import { sealDayWorkflowInstanceId } from './seal-day-run.ts'

function sealWorkflowDouble() {
	const created: Array<{ id: string; params: { day: string } }> = []
	const workflow = {
		async create(options: { id: string; params: { day: string } }) {
			created.push(options)
		},
		async get(id: string) {
			return {
				async status() {
					return { status: 'queued' as const }
				},
			}
		},
	}
	return { workflow, created }
}

function drOpsRequest(
	path: string,
	init: RequestInit & { bearer?: string | null } = {},
) {
	const headers = new Headers(init.headers)
	if (init.bearer !== null) {
		headers.set('Authorization', `Bearer ${init.bearer ?? 'dr-ops-secret'}`)
	}
	return new Request(`https://backup.example${path}`, {
		...init,
		headers,
	})
}

test('DR ops seal routes reject missing or wrong bearer and unset secret', async () => {
	const env = environment()
	const day = '2026-09-22'
	const sealBody = JSON.stringify({ day })

	const unset = await handleControlPlaneFetch(
		drOpsRequest('/__maintenance/dr-seal', {
			method: 'POST',
			bearer: 'dr-ops-secret',
			headers: { 'content-type': 'application/json' },
			body: sealBody,
		}),
		{ ...env, DR_OPS_SECRET: undefined },
	)
	assert.equal(unset.status, 503)

	const missing = await handleControlPlaneFetch(
		drOpsRequest('/__maintenance/dr-seal', {
			method: 'POST',
			bearer: null,
			headers: { 'content-type': 'application/json' },
			body: sealBody,
		}),
		env,
	)
	assert.equal(missing.status, 401)

	const wrong = await handleControlPlaneFetch(
		drOpsRequest('/__maintenance/dr-seal', {
			method: 'POST',
			bearer: 'wrong',
			headers: { 'content-type': 'application/json' },
			body: sealBody,
		}),
		env,
	)
	assert.equal(wrong.status, 401)

	const restoreSecretDenied = await handleControlPlaneFetch(
		drOpsRequest('/__maintenance/dr-seal', {
			method: 'POST',
			bearer: 'dr-restore-secret',
			headers: { 'content-type': 'application/json' },
			body: sealBody,
		}),
		env,
	)
	assert.equal(restoreSecretDenied.status, 401)
})

test('DR ops seal enqueues workflow without Access JWT', async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined)
	const env = environment()
	const double = sealWorkflowDouble()
	env.SEAL_WORKFLOW = double.workflow as unknown as Workflow
	const day = '2026-09-22'
	const instanceId = sealDayWorkflowInstanceId(day)

	const response = await handleControlPlaneFetch(
		drOpsRequest('/__maintenance/dr-seal', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ day }),
		}),
		env,
	)
	assert.equal(response.status, 200)
	assert.deepEqual(await response.json(), { ok: true, day, instanceId })
	assert.deepEqual(double.created, [{ id: instanceId, params: { day } }])

	const status = await handleControlPlaneFetch(
		drOpsRequest(`/__maintenance/seal-status?id=${instanceId}`, {
			method: 'GET',
		}),
		env,
	)
	assert.equal(status.status, 200)
	const body = (await status.json()) as {
		ok: boolean
		id: string
		day: string
		view: { kind: string; status: string }
	}
	assert.equal(body.ok, true)
	assert.equal(body.id, instanceId)
	assert.equal(body.day, day)
	assert.deepEqual(body.view, { kind: 'pending', status: 'queued' })
})

test('DR ops seal-status returns 404 for missing instance and 503 for status read failures', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const env = environment()
	const instanceId = sealDayWorkflowInstanceId('2026-09-22')

	env.SEAL_WORKFLOW = {
		async get() {
			throw new Error('instance not found')
		},
	} as unknown as Workflow
	const missing = await handleControlPlaneFetch(
		drOpsRequest(`/__maintenance/seal-status?id=${instanceId}`, {
			method: 'GET',
		}),
		env,
	)
	assert.equal(missing.status, 404)
	assert.equal(
		((await missing.json()) as { error: string }).error,
		'Seal workflow not found.',
	)

	env.SEAL_WORKFLOW = {
		async get() {
			return {
				async status() {
					throw new Error('workflow status unavailable')
				},
			}
		},
	} as unknown as Workflow
	const unavailable = await handleControlPlaneFetch(
		drOpsRequest(`/__maintenance/seal-status?id=${instanceId}`, {
			method: 'GET',
		}),
		env,
	)
	assert.equal(unavailable.status, 503)
	assert.equal(
		((await unavailable.json()) as { error: string }).error,
		'Unable to read seal workflow status.',
	)
})

test('DR ops paced-drill-status returns the run progress as JSON, 404 for unknown runs, 401 without the bearer', async () => {
	const env = environment()
	const runId = 'paced-drill-2026-11-19-1795086936505'
	const progress = {
		runId,
		day: '2026-11-19',
		status: 'running',
		sources: [{ databaseName: 'kody', phase: 'importing', unitsDone: 3 }],
	}
	await env.BACKUP_BUCKET.put(
		`staging/2026-11-19/d1-paced/isolated-restore-drill/${runId}.json`,
		JSON.stringify(progress),
	)
	const ok = await handleControlPlaneFetch(
		drOpsRequest(`/__maintenance/paced-drill-status?id=${runId}`, {
			method: 'GET',
		}),
		env,
	)
	assert.equal(ok.status, 200)
	assert.deepEqual(await ok.json(), progress)

	const missing = await handleControlPlaneFetch(
		drOpsRequest(
			'/__maintenance/paced-drill-status?id=paced-drill-2026-11-19-1',
			{ method: 'GET' },
		),
		env,
	)
	assert.equal(missing.status, 404)

	const unauthorized = await handleControlPlaneFetch(
		drOpsRequest(`/__maintenance/paced-drill-status?id=${runId}`, {
			method: 'GET',
			bearer: null,
		}),
		env,
	)
	assert.equal(unauthorized.status, 401)
})
