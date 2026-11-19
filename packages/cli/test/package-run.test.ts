import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	followPackageRun,
	PackageRunCancelledError,
	PackageRunFailedError,
	runDurablePackageCheck,
	type PackageRunProgress,
} from '../src/package-run.js'

type Call = { method: string; path: string; body: unknown }

/**
 * A fake API for a token with package scopes only: `packageRunResult` answers
 * with each queued run in turn (and the result once the run is terminal),
 * and `workflowRunList` is forbidden.
 */
function createApi(
	runs: Array<Record<string, unknown>>,
	result: unknown,
	options: { canCancel?: boolean } = {},
) {
	const calls: Array<Call> = []
	let poll = 0
	const fetchFn = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(String(input))
		const method = (init?.method ?? 'GET').toUpperCase()
		const json = (payload: unknown, status = 200) =>
			new Response(JSON.stringify(payload), {
				status,
				headers: { 'content-type': 'application/json' },
			})
		if (url.pathname === '/openapi.json') {
			return json({
				paths: {
					'/v1/packages/check': { post: { operationId: 'packageCheck' } },
					'/v1/workflow-runs': { get: { operationId: 'workflowRunList' } },
					'/v1/workflow-runs/{id}/cancel': {
						post: { operationId: 'workflowRunCancel' },
					},
					'/v1/packages/runs/{workflow_id}': {
						get: { operationId: 'packageRunResult' },
					},
				},
			})
		}
		calls.push({
			method,
			path: url.pathname,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
		})
		if (url.pathname === '/v1/packages/check-uploads') {
			return json({ upload_id: 'pcu_1' }, 201)
		}
		if (url.pathname === '/v1/packages/check') {
			return json({ status: 'dispatched', workflow_id: 'wf-1' })
		}
		if (url.pathname === '/v1/workflow-runs') {
			return json({ error: { code: 'forbidden', message: 'job:read' } }, 403)
		}
		if (url.pathname === '/v1/workflow-runs/wf-1/cancel') {
			return options.canCancel === false
				? json({ error: { code: 'forbidden', message: 'job:execute' } }, 403)
				: json({ ok: true })
		}
		const run: Record<string, unknown> = {
			progress: null,
			last_error: null,
			...runs[Math.min(poll, runs.length - 1)],
		}
		poll += 1
		const stored = run.status !== 'running' && run.status !== 'queued'
		return json(
			stored && result !== null
				? { available: true, kind: 'packageCheck', result, ...run }
				: { available: false, kind: null, result: null, ...run },
		)
	}) as typeof fetch
	return { calls, client: { token: 'kody_at_test', fetchFn, pollMs: 1 } }
}

const checkResult = {
	ok: true,
	package_name: '@acme/poll',
	checks: [{ kind: 'manifest', ok: true, message: 'Validated package.json.' }],
	notices: [],
}

test('a check uploads the tree, starts the run, and follows it with packageRunResult alone, printing each new phase or chunk count once', async () => {
	const building = (done: number) => ({
		status: 'running',
		progress: {
			phase: 'artifact_build',
			message: `Built ${done} of 3 artifact chunks.`,
			done,
			total: 3,
		},
	})
	const api = createApi(
		[
			{ status: 'queued', progress: null },
			building(1),
			building(1),
			building(2),
			{ status: 'complete', progress: building(3).progress },
		],
		checkResult,
	)
	const progress: Array<PackageRunProgress> = []
	const result = await runDurablePackageCheck({
		...api.client,
		tree: {
			files: { 'package.json': '{}' },
			binaryFiles: { 'icon.png': 3 },
			binaryContents: { 'icon.png': 'AAAA' },
		},
		onProgress: (value) => progress.push(value),
	})
	assert.deepEqual(result, checkResult)
	assert.deepEqual(api.calls[0], {
		method: 'POST',
		path: '/v1/packages/check-uploads',
		body: {
			files: { 'package.json': '{}' },
			binary_contents: { 'icon.png': 'AAAA' },
		},
	})
	assert.deepEqual(api.calls[1], {
		method: 'POST',
		path: '/v1/packages/check',
		body: { upload_id: 'pcu_1' },
	})
	assert.deepEqual(
		progress.map((entry) => entry.message),
		[
			'Built 1 of 3 artifact chunks.',
			'Built 2 of 3 artifact chunks.',
			'Built 3 of 3 artifact chunks.',
		],
	)
})

test('interrupting cancels the run on the server', async () => {
	const api = createApi([{ status: 'running', progress: null }], null)
	const controller = new AbortController()
	const following = followPackageRun({
		...api.client,
		workflowId: 'wf-1',
		signal: controller.signal,
		onProgress: () => {},
	})
	controller.abort()
	await assert.rejects(following, PackageRunCancelledError)
	assert.deepEqual(api.calls.at(-1), {
		method: 'POST',
		path: '/v1/workflow-runs/wf-1/cancel',
		body: {},
	})
})

test('a run Kody failed rejects with its last error; a stored refusal is returned', async () => {
	const failed = createApi(
		[{ status: 'errored', last_error: 'Durable Object reset.' }],
		null,
	)
	await assert.rejects(
		followPackageRun({ ...failed.client, workflowId: 'wf-1' }),
		(error: unknown) =>
			error instanceof PackageRunFailedError &&
			error.message === 'Durable Object reset.' &&
			error.runStatus === 'errored',
	)

	const refusal = { status: 'checks_failed', failed_checks: [] }
	const refused = createApi(
		[{ status: 'errored', last_error: 'returned checks_failed' }],
		refusal,
	)
	assert.deepEqual(
		await followPackageRun({ ...refused.client, workflowId: 'wf-1' }),
		refusal,
	)
})

test('a token that cannot cancel says the run keeps going', async () => {
	const api = createApi([{ status: 'running' }], null, { canCancel: false })
	const controller = new AbortController()
	const following = followPackageRun({
		...api.client,
		workflowId: 'wf-1',
		signal: controller.signal,
	})
	controller.abort()
	await assert.rejects(
		following,
		(error: unknown) =>
			error instanceof PackageRunCancelledError &&
			/could not cancel it/.test(error.message),
	)
})

test('a run id the account does not have rejects', async () => {
	const api = createApi([{ status: null }], null)
	await assert.rejects(
		followPackageRun({ ...api.client, workflowId: 'wf-1' }),
		(error: unknown) =>
			error instanceof PackageRunFailedError && /not found/.test(error.message),
	)
})
