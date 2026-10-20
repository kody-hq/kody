import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
	isRetryableSentryUploadFailure,
	planSentrySourcemapUploads,
	reportSentryUploadSoftFailure,
	sentryUploadSoftFailEnabled,
	uploadSentrySourcemapsWithRetry,
} from './sentry-upload-sourcemaps.ts'

async function sourcemapFixture(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'sentry-sourcemaps-'))
	for (const [file, contents] of Object.entries(files)) {
		const absolute = join(root, file)
		await mkdir(dirname(absolute), { recursive: true })
		await writeFile(absolute, contents)
	}
	return {
		root,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true })
		},
	}
}

test('sibling-only deploys upload wrangler maps next to each worker config and skip client assets', async () => {
	await using fixture = await sourcemapFixture({
		'packages/platform-worker/.wrangler/sentry-bundle/index.js': 'platform()',
		'packages/platform-worker/.wrangler/sentry-bundle/index.js.map': '{}',
		'packages/runtime-worker/.wrangler/sentry-bundle/index.js': 'runtime()',
		'packages/runtime-worker/.wrangler/sentry-bundle/index.js.map': '{}',
	})

	expect(planSentrySourcemapUploads({ root: fixture.root })).toEqual({
		ok: true,
		uploads: [
			{
				dir: join(
					fixture.root,
					'packages/platform-worker/.wrangler/sentry-bundle',
				),
				label: 'platform worker bundle',
			},
			{
				dir: join(
					fixture.root,
					'packages/runtime-worker/.wrangler/sentry-bundle',
				),
				label: 'runtime worker bundle',
			},
		],
	})
})

test('origin vite deploys require client maps and upload every worker bundle that has maps', async () => {
	await using fixture = await sourcemapFixture({
		'dist/server/index.js': 'origin()',
		'dist/server/index.js.map': '{}',
		'dist/client/assets/entry.js': 'client()',
		'dist/client/assets/entry.js.map': '{}',
		'packages/platform-worker/.wrangler/sentry-bundle/index.js.map': '{}',
	})

	expect(planSentrySourcemapUploads({ root: fixture.root })).toEqual({
		ok: true,
		uploads: [
			{
				dir: join(fixture.root, 'dist/server'),
				label: 'origin vite worker bundle',
			},
			{
				dir: join(
					fixture.root,
					'packages/platform-worker/.wrangler/sentry-bundle',
				),
				label: 'platform worker bundle',
			},
			{
				dir: join(fixture.root, 'dist/client'),
				label: 'client assets',
			},
		],
	})

	await using originWithoutClient = await sourcemapFixture({
		'dist/server/index.js.map': '{}',
	})
	expect(
		planSentrySourcemapUploads({ root: originWithoutClient.root }),
	).toEqual({
		ok: false,
		error:
			'sentry-upload-sourcemaps: no client source maps in dist/client (expected from vite build).',
	})
})

test('missing worker maps fail the pipeline instead of silently skipping', async () => {
	await using fixture = await sourcemapFixture({
		'dist/client/assets/entry.js.map': '{}',
	})
	const plan = planSentrySourcemapUploads({ root: fixture.root })
	expect(plan.ok).toBe(false)
	if (plan.ok) throw new Error('expected a missing-bundle failure')
	expect(plan.error).toContain(join(fixture.root, 'dist/server'))
	expect(plan.error).toContain(
		join(fixture.root, 'packages/platform-worker/.wrangler/sentry-bundle'),
	)
	expect(plan.error).toContain('sibling deploys still use')
})

test('isRetryableSentryUploadFailure matches 5xx and timeouts only', () => {
	expect(
		isRetryableSentryUploadFailure(
			'sentry reported an error: request failure (http status: 504)\nObject {"detail": String("Downstream timeout")}',
		),
	).toBe(true)
	expect(
		isRetryableSentryUploadFailure('request failure (http status: 502)'),
	).toBe(true)
	expect(isRetryableSentryUploadFailure('ETIMEDOUT connecting to sentry')).toBe(
		true,
	)
	expect(isRetryableSentryUploadFailure('socket hang up')).toBe(true)
	expect(
		isRetryableSentryUploadFailure('request failure (http status: 401)'),
	).toBe(false)
	expect(
		isRetryableSentryUploadFailure('request failure (http status: 403)'),
	).toBe(false)
	expect(isRetryableSentryUploadFailure('invalid auth token')).toBe(false)
})

test('uploadSentrySourcemapsWithRetry retries 504 then succeeds', async () => {
	const sleeps: Array<number> = []
	const retries: Array<number> = []
	let attempts = 0
	const result = await uploadSentrySourcemapsWithRetry({
		dir: '/tmp/maps',
		label: 'origin vite worker bundle',
		release: 'abc',
		org: 'org',
		project: 'project',
		sentryCliWrapper: '/bin/sentry-cli',
		baseDelayMs: 10,
		sleep: async (ms) => {
			sleeps.push(ms)
		},
		onRetry: ({ attempt }) => {
			retries.push(attempt)
		},
		runAttempt: async () => {
			attempts += 1
			if (attempts < 3) {
				return {
					status: 1,
					output:
						'sentry reported an error: request failure (http status: 504)\nDownstream timeout',
				}
			}
			return { status: 0, output: 'uploaded' }
		},
	})
	expect(result).toEqual({ status: 0, output: 'uploaded' })
	expect(attempts).toBe(3)
	expect(retries).toEqual([1, 2])
	expect(sleeps).toEqual([10, 20])
})

test('uploadSentrySourcemapsWithRetry does not retry 4xx auth failures', async () => {
	let attempts = 0
	const result = await uploadSentrySourcemapsWithRetry({
		dir: '/tmp/maps',
		label: 'client assets',
		release: 'abc',
		org: 'org',
		project: 'project',
		sentryCliWrapper: '/bin/sentry-cli',
		runAttempt: async () => {
			attempts += 1
			return {
				status: 1,
				output: 'sentry reported an error: request failure (http status: 401)',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toBe(1)
})

test('sentryUploadSoftFailEnabled reads preview workflow env flags', () => {
	expect(sentryUploadSoftFailEnabled({ SENTRY_UPLOAD_SOFT_FAIL: '1' })).toBe(
		true,
	)
	expect(sentryUploadSoftFailEnabled({ SENTRY_UPLOAD_SOFT_FAIL: 'true' })).toBe(
		true,
	)
	expect(sentryUploadSoftFailEnabled({})).toBe(false)
	expect(sentryUploadSoftFailEnabled({ SENTRY_UPLOAD_SOFT_FAIL: '0' })).toBe(
		false,
	)
})

test('reportSentryUploadSoftFailure emits a warning annotation and step summary', async () => {
	const summaryRoot = await mkdtemp(join(tmpdir(), 'sentry-summary-'))
	const summaryPath = join(summaryRoot, 'summary.md')
	await writeFile(summaryPath, '')
	const log = vi.spyOn(console, 'log').mockImplementation(() => {})
	try {
		reportSentryUploadSoftFailure({
			label: 'origin vite worker bundle',
			status: 1,
			env: { GITHUB_STEP_SUMMARY: summaryPath },
		})
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/^::warning::Sentry source map upload failed/),
		)
		const summary = await readFile(summaryPath, 'utf8')
		expect(summary).toContain('Sentry source map upload warning')
		expect(summary).toContain('origin vite worker bundle')
	} finally {
		log.mockRestore()
		await rm(summaryRoot, { recursive: true, force: true })
	}
})
