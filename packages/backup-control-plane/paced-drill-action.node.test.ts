import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
	accessClaims,
	accessSigner,
	environment,
	MemoryBucket,
	putPacedSealsForDay,
} from './backup-control-plane-test-support.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'
import { dayFromPacedDrillRunId } from './paced-restore-drill.ts'

test('paced drill action drills the chosen sealed day, defaults to the newest, and refuses an unsealed day', async () => {
	resetIsolateState()
	vi.useFakeTimers({ now: new Date('2026-11-20T12:00:00Z'), toFake: ['Date'] })
	const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const bucket = new MemoryBucket()
		const env = environment(bucket)
		await putPacedSealsForDay(bucket, env, '2026-11-16')
		await putPacedSealsForDay(bucket, env, '2026-11-19')
		const created: Array<{
			id: string
			params: { runId: string; day: string }
		}> = []
		env.PACED_DRILL_WORKFLOW = {
			async create(options: (typeof created)[number]) {
				created.push(options)
			},
		} as unknown as Workflow
		const { fetcher, sign } = accessSigner('paced-drill-kid')
		const jwt = sign(accessClaims(env))
		const post = (body: string) =>
			handleControlPlaneFetch(
				new Request('https://backup.example/actions/run-paced-drill', {
					method: 'POST',
					headers: {
						'cf-access-jwt-assertion': jwt,
						'content-type': 'application/x-www-form-urlencoded',
						'sec-fetch-site': 'same-origin',
					},
					body,
				}),
				env,
				fetcher,
			)

		const chosen = await post('day=2026-11-16')
		assert.equal(chosen.status, 303)
		assert.equal(created.length, 1)
		assert.equal(created[0]!.params.day, '2026-11-16')
		assert.equal(dayFromPacedDrillRunId(created[0]!.id), '2026-11-16')
		assert.equal(
			chosen.headers.get('location'),
			`https://backup.example/paced-drill-status?id=${created[0]!.id}`,
		)

		const newest = await post('day=')
		assert.equal(newest.status, 303)
		assert.equal(created.length, 2)
		assert.equal(created[1]!.params.day, '2026-11-19')

		const unsealed = await post('day=2026-11-18')
		assert.notEqual(unsealed.status, 303)
		assert.match(
			await unsealed.text(),
			/2026-11-18 has no sealed paced manifest/,
		)
		assert.equal(created.length, 2)
	} finally {
		vi.useRealTimers()
		consoleLog.mockRestore()
		consoleError.mockRestore()
	}
})
