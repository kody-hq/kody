import assert from 'node:assert/strict'

import { test } from 'vitest'

import { pollD1Export, startD1Export } from './d1-export-api.ts'
import {
	environment,
	exportEnvelope,
	backupError,
} from './backup-control-plane-test-support.ts'

const noSleep = async () => undefined
const respondWith = (response: Response) => ({
	fetcher: async () => response.clone(),
	sleep: noSleep,
})

test('startD1Export classifies auth, transient, and malformed responses', async () => {
	for (const status of [401, 403]) {
		let calls = 0
		await assert.rejects(
			startD1Export(environment(), {
				fetcher: async () => {
					calls += 1
					return new Response('', { status })
				},
				sleep: noSleep,
			}),
			backupError('api-auth-failure', false),
		)
		assert.equal(calls, 1)
	}

	for (const status of [429, 500, 503]) {
		let calls = 0
		const sleeps: number[] = []
		const result = await startD1Export(environment(), {
			fetcher: async () => {
				calls += 1
				return calls === 1
					? new Response('', {
							status,
							headers: status === 429 ? { 'retry-after': '2' } : {},
						})
					: exportEnvelope('complete')
			},
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds)
			},
		})
		assert.equal(result.kind, 'complete')
		assert.equal(calls, 2)
		assert.equal(sleeps[0], status === 429 ? 2_000 : 1_000)
	}

	for (const [response, code] of [
		[new Response('{', { status: 200 }), 'api-malformed-json'],
		[
			Response.json({ success: true, result: { status: 'complete' } }),
			'export-malformed-response',
		],
		[exportEnvelope('error'), 'export-failed'],
		[
			Response.json({
				success: true,
				result: {
					type: 'export',
					success: true,
					at_bookmark: 'bookmark-1',
					status: 'weird',
				},
			}),
			'export-malformed-response',
		],
	] as const) {
		await assert.rejects(
			startD1Export(environment(), respondWith(response)),
			backupError(code),
		)
	}
})

test('export poll covers pending, expired, and malformed states', async () => {
	for (const response of [exportEnvelope(), exportEnvelope('active')]) {
		const result = await startD1Export(environment(), respondWith(response))
		assert.equal(result.kind, 'pending')
		assert.equal(result.bookmark, 'bookmark-1')
	}

	const lost = await pollD1Export(
		environment(),
		'bookmark-1',
		respondWith(exportEnvelope('lost')),
	)
	assert.equal(lost.kind, 'lost')

	await assert.rejects(
		pollD1Export(
			environment(),
			'bookmark-1',
			respondWith(
				Response.json({
					success: true,
					result: { success: false, error: 'something else' },
				}),
			),
		),
		backupError('export-malformed-response'),
	)
})
