import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearOpenApiRouteCache } from '../src/open-api-client.js'
import {
	publishCliExitCode,
	publishRefusalMessage,
	runCli,
} from '../src/cli.js'

test('publishCliExitCode is 0 only for published, already_published, dispatched', () => {
	assert.equal(publishCliExitCode({ status: 'published' }), 0)
	assert.equal(
		publishCliExitCode({
			status: 'already_published',
			artifacts_rebuilt: true,
		}),
		0,
	)
	assert.equal(
		publishCliExitCode({
			status: 'already_published',
			artifacts_rebuilt: false,
		}),
		0,
	)
	assert.equal(publishCliExitCode({ status: 'dispatched' }), 0)
	assert.equal(publishCliExitCode({ status: 'held_for_approval' }), 1)
	assert.equal(publishCliExitCode({ status: 'approval_required' }), 1)
	assert.equal(publishCliExitCode({ status: 'mystery' }), 1)
	assert.equal(publishCliExitCode({}), 1)
	assert.equal(publishCliExitCode(null), 1)
})

test('publishRefusalMessage prefers API message and summarizes checks_failed', () => {
	assert.equal(
		publishRefusalMessage({
			status: 'locked',
			message: 'Package is locked; approve pending_commit first.',
		}),
		'Package is locked; approve pending_commit first.',
	)
	assert.equal(
		publishRefusalMessage({
			status: 'not_fast_forward',
			message: 'Not a fast-forward.',
		}),
		'Not a fast-forward.',
	)
	assert.equal(
		publishRefusalMessage({
			status: 'approval_required',
			message: 'Credential needs changed; owner approval required.',
		}),
		'Credential needs changed; owner approval required.',
	)
	assert.equal(
		publishRefusalMessage({
			status: 'held_for_approval',
			serving_commit: 'aaa',
			held_commit: 'bbb',
			approval_url: 'https://kody.codes/@me/app/approve-capabilities',
		}),
		'This publish is held for approval and is not live. Everyone stays on the serving commit until the owner approves the new capabilities.\nApprove: https://kody.codes/@me/app/approve-capabilities',
	)
	assert.equal(
		publishRefusalMessage({
			status: 'checks_failed',
			failed_checks: [
				{ kind: 'typecheck', ok: false, message: 'TS2345' },
				{ kind: 'manifest', ok: false, message: 'missing name' },
			],
		}),
		'Publish checks failed.\n- typecheck: TS2345\n- manifest: missing name',
	)
	assert.equal(
		publishRefusalMessage({ status: 'checks_failed', failed_checks: [] }),
		'Publish checks failed.',
	)
	assert.equal(
		publishRefusalMessage({ status: 'weird' }),
		'Publish refused (weird).',
	)
	assert.equal(
		publishRefusalMessage({}),
		'Publish refused: response had no status.',
	)
})

const progressLines =
	'kody package publish: running as workflow wf-1.\n' +
	'kody package publish: Running publish checks.\n'

/** `kody package publish` against a run that ends with `body` as its result. */
async function runPublishWithBody(body: unknown) {
	const status =
		body &&
		typeof body === 'object' &&
		['published', 'already_published'].includes(
			(body as { status?: string }).status ?? '',
		)
			? 'complete'
			: 'errored'
	return await runPublishWithRun({ status, result: body })
}

async function runPublishWithRun(run: {
	status: string
	result: unknown
	lastError?: string
}): Promise<{
	code: number
	stdout: string
	stderr: string
}> {
	clearOpenApiRouteCache()
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(String(input))
		const json = (payload: unknown) =>
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		if (url.pathname === '/openapi.json') {
			return json({
				paths: {
					'/v1/packages/{package_id}/external-push': {
						post: { operationId: 'packagePublishExternalPush' },
					},
					'/v1/packages/runs/{workflow_id}': {
						get: { operationId: 'packageRunResult' },
					},
				},
			})
		}
		// Publish always dispatches a durable run; the CLI follows it.
		if (url.pathname === '/v1/packages/pkg-1/external-push') {
			assert.equal((init?.method ?? 'GET').toUpperCase(), 'POST')
			return json({ status: 'dispatched', workflow_id: 'wf-1' })
		}
		assert.equal(url.pathname, '/v1/packages/runs/wf-1')
		return json({
			...(run.result === null
				? { available: false, kind: null, result: null }
				: {
						available: true,
						kind: 'packagePublishExternalPush',
						result: run.result,
					}),
			status: run.status,
			last_error: run.lastError ?? null,
			progress: { phase: 'checks', message: 'Running publish checks.' },
		})
	}) as typeof fetch

	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(
			[
				'package',
				'publish',
				'--params',
				'{"package_id":"pkg-1"}',
				'--token',
				'kody_at_test',
				'--api-url',
				'https://api.kody.codes',
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: (text) => {
					stderr += text
				},
			},
		)
		return { code, stdout, stderr }
	} finally {
		globalThis.fetch = previousFetch
		clearOpenApiRouteCache()
	}
}

test('kody package publish follows its run: exits 0 for published and already_published, 1 for a failed run', async () => {
	const published = await runPublishWithBody({
		status: 'published',
		published_commit: 'abc',
		previous_commit: null,
	})
	assert.equal(published.code, 0)
	assert.match(published.stdout, /"status": "published"/)
	assert.equal(published.stderr, progressLines)

	const noop = await runPublishWithBody({
		status: 'already_published',
		published_commit: 'abc',
		artifacts_rebuilt: true,
	})
	assert.equal(noop.code, 0)
	assert.match(noop.stdout, /"already_published"/)
	assert.match(noop.stdout, /"artifacts_rebuilt": true/)
	assert.equal(noop.stderr, progressLines)

	// A run Kody itself failed stores no result: the reason is its last error.
	const failed = await runPublishWithRun({
		status: 'errored',
		result: null,
		lastError: 'Durable Object reset.',
	})
	assert.equal(failed.code, 1)
	assert.match(failed.stdout, /"status": "failed"/)
	assert.match(failed.stdout, /"workflow_id": "wf-1"/)
	assert.equal(failed.stderr, `${progressLines}Durable Object reset.\n`)
})

test('kody package publish exits 1 and writes the refusal message to stderr', async () => {
	const locked = await runPublishWithBody({
		status: 'locked',
		message: 'Approve the pending commit on the website.',
		pending_commit: 'def',
		approval_url: 'https://kody.codes/approve',
	})
	assert.equal(locked.code, 1)
	assert.match(locked.stdout, /"status": "locked"/)
	assert.equal(
		locked.stderr,
		`${progressLines}Approve the pending commit on the website.\nApprove: https://kody.codes/approve\n`,
	)

	const checks = await runPublishWithBody({
		status: 'checks_failed',
		run_id: 'run-1',
		failed_checks: [{ kind: 'docs', ok: false, message: 'README missing' }],
		manifest: null,
	})
	assert.equal(checks.code, 1)
	assert.match(checks.stdout, /"checks_failed"/)
	assert.equal(
		checks.stderr,
		`${progressLines}Publish checks failed.\n- docs: README missing\n`,
	)

	const nff = await runPublishWithBody({
		status: 'not_fast_forward',
		previous_commit: 'aaa',
		published_commit: 'bbb',
		message: 'HEAD is not a descendant of the published commit.',
	})
	assert.equal(nff.code, 1)
	assert.equal(
		nff.stderr,
		`${progressLines}HEAD is not a descendant of the published commit.\n`,
	)

	const approval = await runPublishWithBody({
		status: 'approval_required',
		message: 'Owner must approve credential need changes.',
		pending_commit: 'ccc',
		approval_url: 'https://kody.codes/approve-creds',
	})
	assert.equal(approval.code, 1)
	assert.equal(
		approval.stderr,
		`${progressLines}Owner must approve credential need changes.\nApprove: https://kody.codes/approve-creds\n`,
	)

	const held = await runPublishWithBody({
		status: 'held_for_approval',
		message:
			'This publish is held for approval and is not live. The owner approves it here: https://kody.codes/@me/app/approve-capabilities',
		serving_commit: 'aaa',
		held_commit: 'bbb',
		approval_url: 'https://kody.codes/@me/app/approve-capabilities',
	})
	assert.equal(held.code, 1)
	assert.equal(
		held.stderr,
		`${progressLines}This publish is held for approval and is not live. The owner approves it here: https://kody.codes/@me/app/approve-capabilities\n`,
	)
	assert.match(held.stdout, /"status": "held_for_approval"/)
	assert.match(held.stdout, /"serving_commit": "aaa"/)
})
