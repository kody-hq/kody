import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import {
	DEFAULT_BACKUP_MAX_SOURCE_BYTES,
	pollD1Export,
	refreshCompletedD1Export,
	startD1Export,
	verifySourceDatabaseIdentity,
} from './d1-export-api.ts'
import {
	environment,
	exportEnvelope,
	identityEnvelope,
	backupError,
} from './backup-control-plane-test-support.ts'

const noSleep = async () => undefined
const respondWith = (response: Response) => ({
	fetcher: async () => response.clone(),
	sleep: noSleep,
})

test('verifies D1 identity size gates without calling the live account endpoint', async () => {
	const consoleError = vi.spyOn(console, 'error')
	const consoleLog = vi.spyOn(console, 'log')
	consoleError.mockImplementation(() => undefined)
	consoleLog.mockImplementation(() => undefined)

	const urls: string[] = []
	await verifySourceDatabaseIdentity(environment(), {
		fetcher: async (input) => {
			urls.push(String(input))
			return identityEnvelope(1_000)
		},
		sleep: noSleep,
	})
	assert.equal(urls.length, 1)
	assert.match(urls[0]!, /\/d1\/database\//)
	assert.equal(consoleLog.mock.calls.length, 1)

	const env = environment()
	const cappedEnv = { ...env, BACKUP_MAX_SOURCE_BYTES: '100' }
	const invalidCapEnv = {
		...env,
		BACKUP_MAX_SOURCE_BYTES: String(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1),
	}
	const rejected: Array<[Response, string, typeof env?]> = [
		[identityEnvelope(undefined, false), 'api-malformed-identity'],
		[identityEnvelope('1000'), 'api-malformed-identity'],
		[identityEnvelope(1.5), 'api-malformed-identity'],
		[identityEnvelope(-1), 'api-malformed-identity'],
		[identityEnvelope(0), 'source-size-zero'],
		[
			identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES),
			'source-size-limit-exceeded',
		],
		[
			identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1),
			'source-size-limit-exceeded',
		],
		[identityEnvelope(100), 'source-size-limit-exceeded', cappedEnv],
		[identityEnvelope(1), 'invalid-max-source-bytes', invalidCapEnv],
	]
	for (const [response, code, candidateEnv = env] of rejected) {
		await assert.rejects(
			verifySourceDatabaseIdentity(candidateEnv, respondWith(response)),
			backupError(code),
		)
	}
	// An invalid configured ceiling throws before any D1 call or log.
	assert.equal(consoleError.mock.calls.length, rejected.length - 1)
	await assert.rejects(
		verifySourceDatabaseIdentity(env, respondWith(identityEnvelope(0))),
		backupError('source-size-zero', true),
	)

	for (const fileSize of [1_000, DEFAULT_BACKUP_MAX_SOURCE_BYTES - 1]) {
		assert.deepEqual(
			await verifySourceDatabaseIdentity(
				env,
				respondWith(identityEnvelope(fileSize)),
			),
			{ fileSize, maxSourceBytes: DEFAULT_BACKUP_MAX_SOURCE_BYTES },
		)
	}
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

test('refresh requires the same bookmark and a complete nonempty signed URL', async () => {
	for (const [response, code, retryable] of [
		[exportEnvelope('active'), 'export-refresh-pending', true],
		[
			exportEnvelope('complete', 'bookmark-2'),
			'export-bookmark-mismatch',
			false,
		],
		[
			exportEnvelope('complete', 'bookmark-1', ''),
			'export-malformed-response',
			false,
		],
	] as const) {
		await assert.rejects(
			refreshCompletedD1Export(
				environment(),
				'bookmark-1',
				respondWith(response),
			),
			backupError(code, retryable),
		)
	}
})

test('export poll and refresh workflow covers pending, expired, and malformed states', async () => {
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

	// An expired poll result fails the refresh instead of starting a second
	// (database-blocking) export inside the same upload step.
	const bodies: unknown[] = []
	await assert.rejects(
		refreshCompletedD1Export(environment(), 'bookmark-1', {
			fetcher: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)))
				return bodies.length === 1
					? exportEnvelope('lost')
					: exportEnvelope('complete', 'bookmark-2')
			},
			sleep: noSleep,
		}),
		backupError('export-result-expired', false),
	)
	assert.deepEqual(bodies, [
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
	])
})
