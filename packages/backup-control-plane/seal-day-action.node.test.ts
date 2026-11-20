import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
	accessClaims,
	accessSigner,
	environment,
} from './backup-control-plane-test-support.ts'
import { workflowBackupErrorMessage } from './backup-policy.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'
import * as sealFullBackup from './seal-full-backup.ts'
import { sealDayWorkflowInstanceId } from './seal-day-run.ts'

type SealInstance = {
	status: 'queued' | 'running' | 'complete' | 'errored' | 'terminated'
	output?: unknown
	error?: { name: string; message: string }
}

function sealWorkflowDouble() {
	const created: Array<{ id: string; params: { day: string } }> = []
	let instance: SealInstance | null = null
	let restarts = 0
	const workflow = {
		async create(options: { id: string; params: { day: string } }) {
			if (instance) throw new Error('instance already exists')
			created.push(options)
			instance = { status: 'queued' }
		},
		async get(id: string) {
			if (!instance || created[0]?.id !== id) {
				throw new Error(`missing seal instance ${id}`)
			}
			return {
				async status() {
					return instance!
				},
				async restart() {
					restarts += 1
					instance = { status: 'queued' }
				},
			}
		},
	}
	return {
		workflow,
		created,
		restartCount: () => restarts,
		setInstance(next: SealInstance) {
			instance = next
		},
	}
}

test('seal day enqueues a workflow and status reports progress, already sealed, and incomplete', async () => {
	resetIsolateState()
	const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const sealSpy = vi.spyOn(sealFullBackup, 'sealFullBackupDay')
	const { fetcher, sign } = accessSigner('seal-route-kid')
	const env = environment()
	const double = sealWorkflowDouble()
	env.SEAL_WORKFLOW = double.workflow as unknown as Workflow
	const day = '2026-09-22'
	const instanceId = sealDayWorkflowInstanceId(day)
	const jwt = sign(accessClaims(env))
	const get = (path: string) =>
		handleControlPlaneFetch(
			new Request(`https://backup.example${path}`, {
				headers: { 'cf-access-jwt-assertion': jwt },
			}),
			env,
			fetcher,
		)
	const post = (body: string, secFetchSite: string | null = 'same-origin') =>
		handleControlPlaneFetch(
			new Request('https://backup.example/actions/seal-day', {
				method: 'POST',
				headers: {
					'cf-access-jwt-assertion': jwt,
					'content-type': 'application/x-www-form-urlencoded',
					...(secFetchSite ? { 'sec-fetch-site': secFetchSite } : {}),
				},
				body,
			}),
			env,
			fetcher,
		)

	const enqueued = await post(`day=${day}`)
	assert.equal(enqueued.status, 303)
	assert.equal(
		enqueued.headers.get('location'),
		`https://backup.example/seal-status?id=${instanceId}`,
	)
	assert.equal(await enqueued.text(), '')
	assert.deepEqual(double.created, [{ id: instanceId, params: { day } }])
	assert.equal(sealSpy.mock.calls.length, 0)
	assert.equal(double.restartCount(), 0)
	const enqueueLog = JSON.parse(String(consoleLog.mock.calls.at(-1)?.[0]))
	assert.equal(enqueueLog.event, 'ui-seal-day')
	assert.equal(enqueueLog.instanceId, instanceId)
	assert.equal(enqueueLog.day, day)

	const manifestKey = `daily/full/${day}/manifest.json`
	const statuses: Array<{
		instance: SealInstance | null
		status: number
		matches: RegExp[]
		absent: string[]
	}> = [
		{
			instance: null,
			status: 200,
			matches: [/Seal for 2026-09-22 is queued/, /http-equiv="refresh"/],
			absent: ['was already sealed', 'not ready to seal'],
		},
		{
			instance: {
				status: 'complete',
				output: { kind: 'sealed', day, manifestKey, alreadySealed: true },
			},
			status: 200,
			matches: [
				/Day 2026-09-22 was already sealed at daily\/full\/2026-09-22\/manifest\.json/,
			],
			absent: ['http-equiv="refresh"'],
		},
		{
			instance: {
				status: 'complete',
				output: { kind: 'sealed', day, manifestKey, alreadySealed: false },
			},
			status: 200,
			matches: [
				/Sealed day 2026-09-22 at daily\/full\/2026-09-22\/manifest\.json/,
			],
			absent: [],
		},
		{
			instance: {
				status: 'errored',
				error: {
					name: 'd1-manifest-missing',
					message: workflowBackupErrorMessage({
						code: 'd1-manifest-missing',
						message:
							'Day 2026-09-22 is not ready to seal (d1-manifest-missing).',
					}),
				},
			},
			status: 409,
			matches: [
				/Day 2026-09-22 is not ready to seal \(d1-manifest-missing\)/,
				/Seal day incomplete/,
			],
			absent: [],
		},
	]
	for (const { instance, status, matches, absent } of statuses) {
		if (instance) double.setInstance(instance)
		const response = await get(`/seal-status?id=${instanceId}`)
		assert.equal(response.status, status)
		const html = await response.text()
		for (const pattern of matches) assert.match(html, pattern)
		for (const text of absent) assert.equal(html.includes(text), false)
	}

	assert.equal((await post(`day=${day}`)).status, 303)
	assert.equal(double.restartCount(), 1)
	assert.equal(double.created.length, 1)
	assert.equal(sealSpy.mock.calls.length, 0)

	assert.equal((await get('/seal-status')).status, 400)
	assert.equal((await get('/seal-status?id=not-a-seal')).status, 400)

	const missingDay = await post('')
	assert.equal(missingDay.status, 400)
	assert.match(await missingDay.text(), /day is required/)
	assert.equal(double.created.length, 1)

	assert.equal((await post(`day=${day}`, null)).status, 403)
	assert.equal(double.created.length, 1)
	assert.equal(sealSpy.mock.calls.length, 0)
	consoleLog.mockRestore()
	consoleError.mockRestore()
	sealSpy.mockRestore()
})
