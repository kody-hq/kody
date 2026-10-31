import { expect, test } from 'vitest'
import { type SitePerfReport } from './collect.ts'
import {
	buildInvokeBody,
	invokeSitePerfPackage,
	resolveWebhookUrl,
	shouldInvokeSitePerfPackage,
} from './invoke-site-perf-package.ts'

const needsFixReport: SitePerfReport = {
	url: 'https://kody.codes/',
	fetchedAt: '2026-08-18T00:00:00.000Z',
	htmlBytes: 1200,
	cacheControl: 'no-store',
	vary: null,
	largestSameOriginJsBytes: 800,
	lcpImageBytes: 800,
	ttfbMs: 80,
	serverTiming: [{ name: 'ssr', durationMs: 20 }],
	pages: [],
	packageApp: null,
	findings: [
		{
			id: 'home-no-store',
			message: 'Anonymous homepage HTML is Cache-Control: no-store.',
		},
	],
	verdict: 'needs-fix',
}

const exampleWebhookUrl = 'https://example.test/webhooks/weekly-site-perf/run'

function invoke(
	overrides: Partial<Parameters<typeof invokeSitePerfPackage>[0]>,
) {
	return invokeSitePerfPackage({
		report: needsFixReport,
		webhookUrl: exampleWebhookUrl,
		repository: 'kody-hq/kody',
		startingRef: 'main',
		runId: '77',
		fetchImpl: async () => {
			throw new Error('should not fetch')
		},
		...overrides,
	})
}

function respondWith(body: unknown, status = 200) {
	return async () => new Response(JSON.stringify(body), { status })
}

test('invoke gates on needs-fix and a webhook URL, and builds a params body', async () => {
	expect(
		shouldInvokeSitePerfPackage({ ...needsFixReport, verdict: 'ok' }),
	).toBe(false)
	expect(shouldInvokeSitePerfPackage(needsFixReport)).toBe(true)
	expect(
		buildInvokeBody({
			report: needsFixReport,
			repository: 'kody-hq/kody',
			startingRef: 'main',
			runId: '99',
		}),
	).toEqual({
		params: {
			report: needsFixReport,
			repository: 'kody-hq/kody',
			startingRef: 'main',
		},
		idempotencyKey: 'weekly-site-perf:99',
	})

	const urlCases: Array<
		[string | undefined, ReturnType<typeof resolveWebhookUrl>]
	> = [
		[undefined, { ok: false, skipped: 'missing-webhook-url' }],
		[
			'https://example.test/webhooks/run',
			{ ok: true, url: 'https://example.test/webhooks/run' },
		],
		[
			'  https://example.test/webhooks/run  ',
			{ ok: true, url: 'https://example.test/webhooks/run' },
		],
		['not-a-url', { ok: false, skipped: 'invalid-webhook-url' }],
		[
			'ftp://example.test/webhooks/run',
			{ ok: false, skipped: 'invalid-webhook-url' },
		],
	]
	expect(urlCases.map(([url]) => [url, resolveWebhookUrl(url)])).toEqual(
		urlCases,
	)

	const skips: Array<[Partial<Parameters<typeof invoke>[0]>, string]> = [
		[{ report: { ...needsFixReport, verdict: 'ok' } }, 'ok'],
		[{ webhookUrl: undefined }, 'missing-webhook-url'],
		[{ webhookUrl: '' }, 'missing-webhook-url'],
		[{ webhookUrl: '   ' }, 'missing-webhook-url'],
		[{ webhookUrl: 'not-a-url' }, 'invalid-webhook-url'],
	]
	for (const [overrides, skipped] of skips) {
		expect(await invoke(overrides)).toEqual({ skipped })
	}
})

test('invoke posts params to the webhook URL, treats replay/in-progress as launched, and surfaces API errors', async () => {
	const calls: Array<{
		url: string
		auth: string | null
		idempotencyKey: string | null
		body: unknown
	}> = []
	const agent = {
		id: 'bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
		url: 'https://cursor.com/agents/bc-aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
	}
	const invoked = await invoke({
		fetchImpl: async (url, init) => {
			const headers = new Headers(init?.headers)
			calls.push({
				url: String(url),
				auth: headers.get('Authorization'),
				idempotencyKey: headers.get('Idempotency-Key'),
				body: JSON.parse(String(init?.body)),
			})
			return respondWith({
				ok: true,
				idempotency: { replayed: false },
				result: { agent },
			})()
		},
	})
	expect(calls).toEqual([
		{
			url: exampleWebhookUrl,
			auth: null,
			idempotencyKey: 'weekly-site-perf:77',
			body: {
				params: {
					report: needsFixReport,
					repository: 'kody-hq/kody',
					startingRef: 'main',
				},
				idempotencyKey: 'weekly-site-perf:77',
			},
		},
	])
	expect(invoked).toEqual({
		invoked: true,
		agentUrl: agent.url,
		result: { agent },
	})

	expect(
		await invoke({
			fetchImpl: respondWith({
				ok: true,
				idempotency: { replayed: true },
				result: { skipped: false },
			}),
		}),
	).toMatchObject({ invoked: true, replayed: true })
	expect(
		await invoke({
			fetchImpl: respondWith(
				{ ok: false, error: { code: 'invocation_in_progress' } },
				409,
			),
		}),
	).toMatchObject({ invoked: true, inProgress: true })

	await expect(
		invoke({
			runId: '88',
			fetchImpl: respondWith(
				{ ok: false, error: { code: 'idempotency_mismatch' } },
				409,
			),
		}),
	).rejects.toThrow(/Kody webhook idempotency mismatch/)
	await expect(
		invoke({
			runId: '88',
			fetchImpl: async () =>
				new Response('upstream unavailable', { status: 503 }),
		}),
	).rejects.toThrow(/Kody webhook 503/)
})
