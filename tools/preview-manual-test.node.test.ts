import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	cookieHeaderFromSetCookie,
	deriveSiblingWorkerUrl,
	displayTitleMentionsPr,
	evaluateAppHealth,
	evaluatePlatformHealth,
	evaluateRuntimeHealth,
	flattenGhJsonPages,
	formatBriefing,
	isCancelledOrSupersededPreviewRun,
	parseArgs,
	parsePreviewComment,
	parseSessionRequest,
	previewCommentMarker,
	previewSeedEmail,
	runPreviewManualTest,
	selectPreviewWorkflowRun,
	shellQuote,
	workerNameFromPreviewUrl,
	type GhResult,
	type PreviewManualTestDeps,
	type PreviewManualTestResult,
} from './preview-manual-test.ts'

const sampleComment = [
	previewCommentMarker,
	'🔎 Preview deployed: https://kody-pr-42.kody.workers.dev',
	'',
	'Worker: `kody-pr-42`',
	'Runtime worker: `kody-pr-42-runtime` (https://kody-pr-42-runtime.kody.workers.dev)',
	'Platform worker: `kody-pr-42-platform` (https://kody-pr-42-platform.kody.workers.dev)',
	'API worker: `kody-pr-42-api` (https://kody-pr-42-api.kody.workers.dev)',
	'D1: `kody-pr-42-db`',
	'KV: `kody-pr-42-oauth-kv`',
	'',
	'Mocks:',
	'- cloudflare: [https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks](https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks?token=abc) (`kody-pr-42-mock-cloudflare`)',
].join('\n')

const plainSpec = {
	expectedStatus: null,
	body: null,
	form: null,
	headers: [],
	dump: false,
	contains: [],
}

test('preview manual test parses flags, PR comments, worker URLs, and health payloads', () => {
	expect(
		parseArgs(
			'--pr 42 --no-wait --skip-login --timeout-ms 1000 --poll-ms 50 --sha abc123 --json'.split(
				' ',
			),
		),
	).toMatchObject({
		prNumber: 42,
		wait: false,
		skipLogin: true,
		timeoutMs: 1000,
		pollIntervalMs: 50,
		expectedSha: 'abc123',
		json: true,
	})
	expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/)
	expect(() => parseArgs(['--check', '/account', '--skip-login'])).toThrow(
		/--check requires a session cookie/,
	)
	expect(() =>
		parseArgs(['--request', 'GET /account/secrets.json', '--skip-login']),
	).toThrow(/--request requires a session cookie/)
	expect(
		parseArgs([
			'--request',
			'POST /account/secrets.json {"action":"save","scope":"user","name":"previewSeed","value":"preview-seed-value","allowedHosts":["api.example.com"]}',
			'--request',
			'GET /admin 403',
			'--cookie-file',
			'.tmp/preview-cookie',
		]),
	).toEqual(
		expect.objectContaining({
			cookieFile: '.tmp/preview-cookie',
			sessionRequests: [
				{
					...plainSpec,
					method: 'POST',
					path: '/account/secrets.json',
					body: {
						action: 'save',
						scope: 'user',
						name: 'previewSeed',
						value: 'preview-seed-value',
						allowedHosts: ['api.example.com'],
					},
				},
				{ ...plainSpec, method: 'GET', path: '/admin', expectedStatus: 403 },
			],
		}),
	)
	expect(parseSessionRequest('GET /account/secrets.json')).toEqual({
		...plainSpec,
		method: 'GET',
		path: '/account/secrets.json',
	})
	expect(() => parseSessionRequest('FETCH /nope')).toThrow(/Invalid --request/)

	expect(parsePreviewComment('no marker here')).toBeNull()
	const mock =
		'cloudflare: [https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks](https://kody-pr-42-mock-cloudflare.kody.workers.dev/__mocks?token=abc) (`kody-pr-42-mock-cloudflare`)'
	expect(parsePreviewComment(sampleComment)).toEqual({
		previewUrl: 'https://kody-pr-42.kody.workers.dev',
		workerName: 'kody-pr-42',
		runtimeWorkerName: 'kody-pr-42-runtime',
		runtimeUrl: 'https://kody-pr-42-runtime.kody.workers.dev',
		platformWorkerName: 'kody-pr-42-platform',
		platformUrl: 'https://kody-pr-42-platform.kody.workers.dev',
		apiWorkerName: 'kody-pr-42-api',
		apiUrl: 'https://kody-pr-42-api.kody.workers.dev',
		d1DatabaseName: 'kody-pr-42-db',
		oauthKvTitle: 'kody-pr-42-oauth-kv',
		mocks: [mock],
	})
	expect(
		parsePreviewComment(
			[
				sampleComment,
				'',
				'### Seed login (public preview fixture)',
				'',
				'- Email: `me@kentcdodds.com`',
				'- Password: `ilikecode`',
				'- Already signed in: `npm run control-kody -- browse`',
			].join('\n'),
		)?.mocks,
	).toEqual([mock])
	expect(
		parsePreviewComment(sampleCommentWithUrl('http://127.0.0.1:9')),
	).toEqual({
		previewUrl: 'http://127.0.0.1:9',
		workerName: 'kody-pr-42',
		runtimeWorkerName: null,
		runtimeUrl: null,
		platformWorkerName: null,
		platformUrl: null,
		apiWorkerName: null,
		apiUrl: null,
		d1DatabaseName: null,
		oauthKvTitle: null,
		mocks: [],
	})

	expect(workerNameFromPreviewUrl('https://kody-pr-42.kody.workers.dev')).toBe(
		'kody-pr-42',
	)
	expect(workerNameFromPreviewUrl('http://127.0.0.1:3742')).toBeNull()
	expect(
		deriveSiblingWorkerUrl(
			'https://kody-pr-42.kody.workers.dev',
			'kody-pr-42',
			'kody-pr-42-runtime',
		),
	).toBe('https://kody-pr-42-runtime.kody.workers.dev')
	expect(
		cookieHeaderFromSetCookie(['kody_session=abc; Path=/; HttpOnly']),
	).toBe('kody_session=abc')

	const fullSha = '91bab582b2040e7b55a84f2415be82c1684ad565'
	expect(
		[
			evaluateAppHealth({ ok: true, commitSha: 'abc' }, 'abc'),
			evaluateAppHealth({ ok: true, commitSha: fullSha }, '91bab582'),
			evaluateAppHealth({ ok: true, commitSha: 'mergesha' }, 'headsha', [
				'basesha',
				'headsha',
			]),
		].map(({ ok, commitSha }) => ({ ok, commitSha })),
	).toEqual([
		{ ok: true, commitSha: 'abc' },
		{ ok: true, commitSha: fullSha },
		{ ok: true, commitSha: 'mergesha' },
	])
	expect(evaluateAppHealth({ ok: true, commitSha: 'old' }, 'new').ok).toBe(
		false,
	)
	for (const evaluate of [evaluateRuntimeHealth, evaluatePlatformHealth]) {
		for (const cookieSecretConfigured of [true, false]) {
			expect(
				evaluate(
					{ status: 'ok', commitSha: 'abc', cookieSecretConfigured },
					null,
				).ok,
			).toBe(cookieSecretConfigured)
		}
	}

	const titles: Array<[string | undefined, number, boolean]> = [
		['Preview #42', 42, true],
		['Preview #42', 4, false],
		['Preview #4', 4, true],
		['Preview #4 from main', 4, true],
		[undefined, 4, false],
	]
	expect(
		titles.filter(
			([title, pr, want]) => displayTitleMentionsPr(title, pr) !== want,
		),
	).toEqual([])

	expect(flattenGhJsonPages([{ body: 'a' }, { body: 'b' }])).toEqual([
		{ body: 'a' },
		{ body: 'b' },
	])
	expect(
		flattenGhJsonPages([[{ body: 'a' }], [{ body: 'b' }, { body: 'c' }]]),
	).toEqual([{ body: 'a' }, { body: 'b' }, { body: 'c' }])
	expect(flattenGhJsonPages({ not: 'an array' })).toEqual([])

	expect(
		isCancelledOrSupersededPreviewRun({
			status: 'completed',
			conclusion: 'cancelled',
		}),
	).toBe(true)
	expect(
		isCancelledOrSupersededPreviewRun({
			status: 'completed',
			conclusion: 'skipped',
		}),
	).toBe(false)
	expect(
		isCancelledOrSupersededPreviewRun({
			status: 'completed',
			conclusion: 'success',
		}),
	).toBe(false)
	expect(
		isCancelledOrSupersededPreviewRun({
			status: 'in_progress',
			conclusion: null,
		}),
	).toBe(false)

	const olderSuccess = {
		databaseId: 10,
		status: 'completed',
		conclusion: 'success',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/10',
		displayTitle: 'Preview #42',
	}
	const cancelled = {
		databaseId: 11,
		status: 'completed',
		conclusion: 'cancelled',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/11',
		displayTitle: 'Preview #42',
	}
	const newerSuccess = {
		databaseId: 12,
		status: 'completed',
		conclusion: 'success',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/12',
		displayTitle: 'Preview #42',
	}
	const skippedNoop = {
		databaseId: 13,
		status: 'completed',
		conclusion: 'skipped',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/13',
		displayTitle: 'Preview #42',
	}
	const olderOtherPr = {
		databaseId: 14,
		status: 'completed',
		conclusion: 'success',
		headSha: 'other',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/14',
		displayTitle: 'Preview #99',
	}
	// Cancelled first in the list (the latch bug): still follow the newest
	// runnable run for the PR head SHA (#3770).
	expect(
		selectPreviewWorkflowRun([cancelled, newerSuccess, olderOtherPr], {
			number: 42,
			headRefOid: 'headsha',
		}),
	).toEqual(newerSuccess)
	expect(
		selectPreviewWorkflowRun([cancelled], {
			number: 42,
			headRefOid: 'headsha',
		}),
	).toBeNull()
	// Newer cancelled same-SHA redeploy: do not fall back to older success.
	expect(
		selectPreviewWorkflowRun([olderSuccess, cancelled], {
			number: 42,
			headRefOid: 'headsha',
		}),
	).toBeNull()
	// Skipped no-op (non-preview-flag label): look past it to older success.
	expect(
		selectPreviewWorkflowRun([olderSuccess, skippedNoop], {
			number: 42,
			headRefOid: 'headsha',
		}),
	).toEqual(olderSuccess)
	expect(
		selectPreviewWorkflowRun([cancelled, olderOtherPr], {
			number: 42,
			headRefOid: 'missing',
		}),
	).toBeNull()
})

test('preview manual test --request specs accept control-kody request --dump/--contains flags', () => {
	expect(
		parseSessionRequest('GET /pricing --dump --contains Worker compute'),
	).toEqual({
		...plainSpec,
		method: 'GET',
		path: '/pricing',
		dump: true,
		contains: ['Worker compute'],
	})
	expect(
		parseSessionRequest(
			String.raw`GET /pricing 200 --contains Worker\ compute --contains "is metered"`,
		),
	).toEqual(
		expect.objectContaining({
			expectedStatus: 200,
			dump: false,
			contains: ['Worker compute', 'is metered'],
		}),
	)
	expect(
		parseSessionRequest(
			'POST /account/secrets.json 201 {"action":"save"} --contains selectedSecretId',
		),
	).toEqual(
		expect.objectContaining({
			expectedStatus: 201,
			body: { action: 'save' },
			contains: ['selectedSecretId'],
		}),
	)
	expect(
		parseSessionRequest(
			'POST /account/secrets.json {"value":"use --dump --contains"} --contains "a --dump b" --contains Kent\'s --dump',
		),
	).toEqual(
		expect.objectContaining({
			body: { value: 'use --dump --contains' },
			dump: true,
			contains: ['a --dump b', "Kent's"],
		}),
	)
	expect(
		parseSessionRequest(
			String.raw`GET /docs --contains C:\tools\kody --contains '\n stays'`,
		).contains,
	).toEqual([String.raw`C:\tools\kody`, String.raw`\n stays`])
	expect(() => parseSessionRequest('GET /pricing --contains')).toThrow(
		/--contains requires text/,
	)
	expect(() => parseSessionRequest('GET /pricing --dump nope')).toThrow(
		/--dump takes no value/,
	)
	expect(() => parseSessionRequest('GET /pricing oops')).toThrow(
		/GET --request cannot include a JSON body: oops[\s\S]*--contains <text>/,
	)
	expect(
		parseSessionRequest(
			'POST /account/organizations/new 302 --form slug=x-org --form displayName=X --contains /@x-org',
		),
	).toEqual({
		...plainSpec,
		method: 'POST',
		path: '/account/organizations/new',
		expectedStatus: 302,
		form: {
			encoding: 'urlencoded',
			fields: [
				{ name: 'slug', value: 'x-org', filePath: null },
				{ name: 'displayName', value: 'X', filePath: null },
			],
		},
		contains: ['/@x-org'],
	})
	expect(
		parseSessionRequest(
			'POST /account/profile/avatar.json --multipart --form avatar=@./avatar.png --form alt=me',
		).form,
	).toEqual({
		encoding: 'multipart',
		fields: [
			{ name: 'avatar', value: '', filePath: './avatar.png' },
			{ name: 'alt', value: 'me', filePath: null },
		],
	})
	expect(() =>
		parseSessionRequest(
			'POST /account/organizations/new {"slug":"x"} --form slug=x',
		),
	).toThrow(/both a JSON body and --form/)
	expect(() =>
		parseSessionRequest(
			'POST /account/profile/avatar.json --form avatar=@./a.png',
		),
	).toThrow(/requires --multipart/)
	expect(() =>
		parseSessionRequest('POST /account/organizations/new --multipart'),
	).toThrow(/requires at least one --form/)
	expect(() =>
		parseSessionRequest('GET /account/organizations/new --form slug=x'),
	).toThrow(/GET --request cannot include form fields/)

	expect(
		parseArgs([
			'--request',
			'GET /pricing',
			'--dump',
			'--contains',
			'Worker compute',
			'--request',
			'GET /account',
		]).sessionRequests,
	).toEqual([
		expect.objectContaining({
			path: '/pricing',
			dump: true,
			contains: ['Worker compute'],
		}),
		expect.objectContaining({ path: '/account', dump: false, contains: [] }),
	])
	expect(() => parseArgs(['--contains', 'x'])).toThrow(
		/--contains applies to the previous --request/,
	)
})

test('preview manual test --request --dump/--contains assert the raw response body', async () => {
	await using server = await createPreviewFixtureServer()
	const logs: Array<string> = []
	const files = new Map<string, string>()
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--request',
			'GET /pricing --dump --contains Worker compute',
			'--request',
			'GET /account/secrets.json --contains previewSeed',
			'--json',
		],
		createSilentDeps({ logs, files }),
	)
	expect(exitCode).toBe(0)
	const checks = result?.smoke?.checks ?? []
	expect(checks.find((check) => check.name === 'GET /pricing (2xx)')).toEqual(
		expect.objectContaining({
			ok: true,
			detail: expect.stringContaining('dumped .tmp/control-kody-body'),
		}),
	)
	expect(files.get('.tmp/control-kody-body')).toBe(
		'<h1>Pricing</h1><p>Worker compute is metered.</p>',
	)

	const failing = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--request',
			'GET /pricing --dump',
			'--request',
			'GET /admin 403 --dump --contains Worker compute',
			'--json',
		],
		createSilentDeps({ logs, files }),
	)
	expect(failing.exitCode).toBe(1)
	expect(
		failing.result?.smoke?.checks.find(
			(check) => check.name === 'GET /admin (403)',
		),
	).toEqual(
		expect.objectContaining({
			ok: false,
			detail: expect.stringContaining(
				'response body does not contain "Worker compute"',
			),
		}),
	)
	expect(files.get('.tmp/control-kody-body-1')).toContain('Pricing')
	expect(files.get('.tmp/control-kody-body-2')).toBe('forbidden')
})

test('preview manual test smokes a local preview: health, login page, auth, session, account, mcp', async () => {
	await using server = await createPreviewFixtureServer()
	const logs: Array<string> = []
	const files = new Map<string, string>()
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--cookie-file',
			'.tmp/preview-cookie',
			'--request',
			'POST /account/secrets.json {"action":"save","scope":"user","name":"previewSeed","value":"preview-seed-value","allowedHosts":["api.example.com"]}',
			'--request',
			'GET /account/secrets.json',
			'--request',
			'GET /admin 403',
			'--check',
			'/account/secrets',
			'--json',
		],
		createSilentDeps({ logs, files }),
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.smoke?.ok).toBe(true)
	expect(result?.smoke?.sessionEmail).toBe(previewSeedEmail)
	expect(result?.session.cookieHeader).toBe('kody_session=test-cookie')
	const writtenCookie = files.get('.tmp/preview-cookie') ?? ''
	expect(writtenCookie).toContain('# origin=')
	expect(writtenCookie).toContain(`# email=${previewSeedEmail}`)
	expect(writtenCookie).toContain('kody_session=test-cookie')
	expect(logs.join('\n')).not.toContain('kody_session=test-cookie')
	expect(logs.join('\n')).toContain('"cookieHeader": "present"')
	expect(result?.smoke?.checks.map((check) => check.name)).toEqual([
		'GET /health',
		'GET /login',
		'GET /mcp',
		'POST /auth',
		'GET /session',
		'GET /account',
		'cookie-file',
		'POST /account/secrets.json (2xx)',
		'GET /account/secrets.json (2xx)',
		'GET /admin (403)',
		'GET /account/secrets',
	])
	expect(result?.briefing).toContain(server.origin)
	expect(result?.briefing).toContain('/account/secrets.json')
})

test('preview --request sends urlencoded and multipart form bodies', async () => {
	await using server = await createPreviewFixtureServer()
	const avatarDir = await mkdtemp(path.join(tmpdir(), 'kody-form-'))
	const avatarPath = path.join(avatarDir, 'avatar.png')
	await writeFile(avatarPath, 'png-bytes')
	try {
		const { exitCode, result } = await runPreviewManualTest(
			[
				'--url',
				server.origin,
				'--no-wait',
				'--request',
				'POST /account/organizations/new 302 --form slug=x-org --form displayName=X --contains /@x-org',
				'--request',
				`POST /account/profile/avatar.json --multipart --form avatar=@${avatarPath} --contains avatar`,
				'--json',
			],
			createSilentDeps({ logs: [] }),
		)
		expect(exitCode).toBe(0)
		expect(result?.ok).toBe(true)
		expect(server.captured.map((entry) => entry.path)).toEqual([
			'/account/organizations/new',
			'/account/profile/avatar.json',
		])
		expect(server.captured[0]).toMatchObject({
			contentType: 'application/x-www-form-urlencoded',
			body: 'slug=x-org&displayName=X',
		})
		const upload = server.captured[1]
		expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/)
		expect(upload?.body).toContain('name="avatar"')
		expect(upload?.body).toContain('filename="avatar.png"')
		expect(upload?.body).toContain('Content-Type: image/png')
		expect(upload?.body).toContain('png-bytes')
	} finally {
		await rm(avatarDir, { recursive: true, force: true })
	}
})

test('preview --request --header parses Name: value pairs and rejects session-managed headers', () => {
	expect(
		parseSessionRequest(
			"GET /account/connected-agents.json --header 'Referer: https://kody.test/@acme/-/agents' --header X-Trace:abc --contains agents",
		),
	).toEqual({
		...plainSpec,
		method: 'GET',
		path: '/account/connected-agents.json',
		headers: [
			{ name: 'Referer', value: 'https://kody.test/@acme/-/agents' },
			{ name: 'X-Trace', value: 'abc' },
		],
		contains: ['agents'],
	})
	expect(() => parseSessionRequest('GET /account --header Referer')).toThrow(
		/--header expects 'Name: value'/,
	)
	expect(() =>
		parseSessionRequest('GET /account --header Cookie: kody_session=x'),
	).toThrow(/cannot set Cookie: the session cookie comes from --cookie-file/)
	expect(() =>
		parseSessionRequest(
			'POST /account/secrets.json --header content-type: text/plain --form a=b',
		),
	).toThrow(/cannot set content-type: Content-Type comes from the JSON body/)
	expect(() =>
		parseSessionRequest('GET /account --header A: 1 --header a: 2'),
	).toThrow(/--header a is set more than once/)
})

test('preview --request --header sends the header with the session cookie and replaces the default Accept', async () => {
	await using server = await createPreviewFixtureServer()
	const referer = `${server.origin}/@acme/-/agents`
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--request',
			`GET /account/connected-agents.json --header 'Referer: ${referer}' --header 'accept: application/vnd.kody+json' --contains ${referer}`,
			'--json',
		],
		createSilentDeps({ logs: [] }),
	)
	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(server.echoed).toEqual([
		{
			referer,
			accept: 'application/vnd.kody+json',
			cookie: 'kody_session=test-cookie',
		},
	])
})

test('preview manual test waits for the GitHub preview comment and head SHA workflow before smoking', async () => {
	await using server = await createPreviewFixtureServer('headsha')
	let now = 0
	let prViews = 0
	const logs: Array<string> = []
	const deps = createSilentDeps({
		logs,
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
		execGh: async (args) => {
			if (args.join(' ').startsWith('pr view')) prViews += 1
			const commentReady = prViews >= 2
			return fakeGh(args, {
				commentBody: commentReady ? sampleCommentWithUrl(server.origin) : null,
				headSha: 'headsha',
				runStatus: commentReady ? 'completed' : 'in_progress',
				runConclusion: commentReady ? 'success' : null,
			})
		},
	})

	const { exitCode, result } = await runPreviewManualTest(
		[
			'--pr',
			'42',
			'--timeout-ms',
			'30000',
			'--poll-ms',
			'1000',
			'--skip-login',
		],
		deps,
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.snapshot.previewUrl).toBe(server.origin)
	expect(
		result?.smoke?.checks.some((check) => check.name === 'POST /auth'),
	).toBe(false)
	expect(prViews).toBeGreaterThanOrEqual(2)
	expect(result?.snapshot.workflowStatus).toBe('completed')
	expect(result?.snapshot.workflowConclusion).toBe('success')
})

test('briefing single-quotes KODY_API_URL so comment-sourced shell metacharacters do not run on paste', () => {
	const hostile = 'https://evil.example/$(touch%/tmp/pwned)`id`&sleep%201;true'
	expect(shellQuote(hostile)).toBe(`'${hostile}'`)
	expect(shellQuote("https://x.test/o'clock")).toBe(
		`'https://x.test/o'\\''clock'`,
	)
	// parsePreviewComment's URL capture is `https?:\/\/[^)\s]+`, so `$()`,
	// backticks, `;`, and `&` can reach the briefing line; quote them.
	const briefing = formatBriefing({
		ok: true,
		message: 'ready',
		options: parseArgs(['--skip-login']),
		snapshot: {
			prNumber: 1,
			prUrl: null,
			isDraft: false,
			headSha: null,
			previewUrl: 'https://kody-pr-1.kody.workers.dev',
			workerName: 'kody-pr-1',
			runtimeWorkerName: null,
			runtimeUrl: null,
			platformWorkerName: null,
			platformUrl: null,
			apiWorkerName: 'kody-pr-1-api',
			apiUrl: hostile,
			d1DatabaseName: null,
			oauthKvTitle: null,
			mocks: [],
			expectedSha: null,
			workflowUrl: null,
			workflowStatus: null,
			workflowConclusion: null,
			workflowHeadSha: null,
		},
		smoke: null,
		session: { cookieHeader: null, origin: null, cookieFile: null },
		login: {
			email: previewSeedEmail,
			password: 'x',
			username: 'x',
			admin: false,
		},
		briefing: '',
	} satisfies PreviewManualTestResult)
	expect(briefing).toContain(`export KODY_API_URL='${hostile}'`)
	expect(briefing.includes(`export KODY_API_URL=${hostile}`)).toBe(false)
})

test('preview briefing prints the API host the CLI needs for auth bootstrap and execute --local', async () => {
	await using server = await createPreviewFixtureServer('headsha')
	const apiUrl = 'https://kody-pr-42-api.kody.workers.dev'
	const fromComment = await runPreviewManualTest(
		['--pr', '42', '--skip-login'],
		createSilentDeps({
			logs: [],
			execGh: async (args) =>
				fakeGh(args, {
					commentBody: [
						sampleCommentWithUrl(server.origin),
						`API worker: \`kody-pr-42-api\` (${apiUrl})`,
					].join('\n'),
					headSha: 'headsha',
					runStatus: 'completed',
					runConclusion: 'success',
				}),
		}),
	)
	expect(fromComment.exitCode).toBe(0)
	expect(fromComment.result?.snapshot).toMatchObject({
		apiWorkerName: 'kody-pr-42-api',
		apiUrl,
	})
	expect(fromComment.result?.briefing).toContain(
		`API: ${apiUrl} (\`kody-pr-42-api\`)`,
	)
	expect(fromComment.result?.briefing).toContain(
		`export KODY_API_URL='${apiUrl}'`,
	)

	const fromUrl = await runPreviewManualTest(
		[
			'--url',
			'https://kody-pr-7.kody-a99.workers.dev',
			'--no-wait',
			'--skip-login',
		],
		{
			...createSilentDeps({ logs: [] }),
			fetch: async () => {
				throw new Error('offline')
			},
		},
	)
	expect(fromUrl.result?.snapshot).toMatchObject({
		apiWorkerName: 'kody-pr-7-api',
		apiUrl: 'https://kody-pr-7-api.kody-a99.workers.dev',
	})
	expect(fromUrl.result?.briefing).toContain(
		"export KODY_API_URL='https://kody-pr-7-api.kody-a99.workers.dev'",
	)

	const overridden = await runPreviewManualTest(
		[
			'--pr',
			'42',
			'--url',
			'https://kody-pr-7.kody-a99.workers.dev',
			'--no-wait',
			'--skip-login',
		],
		{
			...createSilentDeps({
				logs: [],
				execGh: async (args) =>
					fakeGh(args, {
						commentBody: [
							sampleCommentWithUrl('https://kody-pr-42.kody-a99.workers.dev'),
							'API worker: `kody-pr-42-api` (https://kody-pr-42-api.kody-a99.workers.dev)',
						].join('\n'),
						headSha: 'headsha',
						runStatus: 'completed',
						runConclusion: 'success',
					}),
			}),
			fetch: async () => {
				throw new Error('offline')
			},
		},
	)
	expect(overridden.result?.snapshot).toMatchObject({
		previewUrl: 'https://kody-pr-7.kody-a99.workers.dev',
		apiWorkerName: 'kody-pr-7-api',
		apiUrl: 'https://kody-pr-7-api.kody-a99.workers.dev',
	})
})

test('preview --url skips gh even when --pr is set', async () => {
	await using server = await createPreviewFixtureServer()
	let ghCalls = 0
	const logs: Array<string> = []
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--pr',
			'4510',
			'--url',
			server.origin,
			'--no-wait',
			'--request',
			'GET /session',
			'--json',
		],
		createSilentDeps({
			logs,
			execGh: async () => {
				ghCalls += 1
				return {
					status: 1,
					stdout: '',
					stderr: 'To get started with GitHub CLI, please run: gh auth login',
				}
			},
		}),
	)
	expect(ghCalls).toBe(0)
	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.snapshot).toMatchObject({
		prNumber: 4510,
		previewUrl: server.origin,
		headSha: null,
	})
	expect(result?.smoke?.commitSha).toBeTruthy()
	expect(logs.join('\n')).toMatch(/no expected \/health commitSha/)
	expect(result?.smoke?.checks.map((check) => check.name)).toContain(
		'GET /session (2xx)',
	)
})

test('preview --url --sha wait status requires an exact /health match', async () => {
	await using server = await createPreviewFixtureServer('deployedsha')
	let now = 0
	const logs: Array<string> = []
	const { exitCode, result } = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--sha',
			'expectedsha',
			'--timeout-ms',
			'2500',
			'--poll-ms',
			'1000',
			'--skip-login',
		],
		createSilentDeps({
			logs,
			now: () => now,
			sleep: async (ms) => {
				now += ms
			},
			execGh: async () => {
				throw new Error('gh should not run for --url')
			},
		}),
	)

	expect(exitCode).toBe(1)
	expect(result).toBeNull()
	expect(logs.join('\n')).toMatch(
		/Waiting for \/health to serve expectedsha \(exact match\)/,
	)
	expect(logs.join('\n')).not.toMatch(/merge commit/)
})

test('preview manual test treats merge-commit /health as ready when it contains the PR head', async () => {
	await using server = await createPreviewFixtureServer('mergesha')
	const logs: Array<string> = []
	const { exitCode, result } = await runPreviewManualTest(
		['--pr', '42', '--skip-login'],
		createSilentDeps({
			logs,
			execGh: async (args) =>
				fakeGh(args, {
					commentBody: sampleCommentWithUrl(server.origin),
					headSha: 'headsha',
					runStatus: 'completed',
					runConclusion: 'success',
					commitParents: ['basesha', 'headsha'],
				}),
		}),
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.smoke?.commitSha).toBe('mergesha')
	expect(
		result?.smoke?.checks.find((check) => check.name === 'GET /health')?.ok,
	).toBe(true)
})

test('preview manual test records fetch and cookie-file failures as checks instead of aborting the briefing', async () => {
	const logs: Array<string> = []
	const fetchFailure = await runPreviewManualTest(
		[
			'--url',
			'https://kody-pr-42.example.invalid',
			'--no-wait',
			'--skip-login',
		],
		{
			...createSilentDeps({ logs }),
			fetch: async () => {
				throw new Error('The operation was aborted due to timeout')
			},
		},
	)

	expect(fetchFailure.exitCode).toBe(1)
	expect(fetchFailure.result).not.toBeNull()
	expect(fetchFailure.result?.briefing).toContain('GET /health')
	expect(
		fetchFailure.result?.smoke?.checks.some(
			(check) =>
				check.name === 'GET /health' &&
				!check.ok &&
				check.detail.includes('aborted due to timeout'),
		),
	).toBe(true)
	expect(
		fetchFailure.result?.smoke?.checks.some(
			(check) => check.name === 'GET /login',
		),
	).toBe(true)

	await using server = await createPreviewFixtureServer()
	const cookieFailure = await runPreviewManualTest(
		[
			'--url',
			server.origin,
			'--no-wait',
			'--cookie-file',
			'.tmp/preview-cookie',
		],
		{
			...createSilentDeps({ logs }),
			writeFile: async () => {
				throw new Error(
					"ENOENT: no such file or directory, open '.tmp/preview-cookie'",
				)
			},
		},
	)

	expect(cookieFailure.exitCode).toBe(1)
	expect(cookieFailure.result).not.toBeNull()
	expect(cookieFailure.result?.session.cookieHeader).toBe(
		'kody_session=test-cookie',
	)
	expect(
		cookieFailure.result?.smoke?.checks.find(
			(check) => check.name === 'cookie-file',
		),
	).toEqual({
		name: 'cookie-file',
		ok: false,
		detail: "ENOENT: no such file or directory, open '.tmp/preview-cookie'",
	})
	expect(cookieFailure.result?.briefing).toContain('POST /auth')
})

test('preview manual test refuses draft PRs and failed preview workflows', async () => {
	const logs: Array<string> = []
	const draft = await runPreviewManualTest(['--pr', '9', '--no-wait'], {
		...createSilentDeps({ logs }),
		execGh: async (args) =>
			fakeGh(args, {
				isDraft: true,
				commentBody: null,
			}),
	})
	expect(draft.exitCode).toBe(1)
	expect(draft.result).toBeNull()
	expect(logs.join('\n')).toMatch(/draft/i)

	logs.length = 0
	const failed = await runPreviewManualTest(
		['--pr', '9', '--timeout-ms', '1000', '--poll-ms', '10'],
		{
			...createSilentDeps({
				logs,
				now: () => 0,
				sleep: async () => {
					// The failed conclusion should abort before a sleep.
				},
			}),
			execGh: async (args) =>
				fakeGh(args, {
					commentBody: null,
					runStatus: 'completed',
					runConclusion: 'failure',
					runUrl: 'https://github.com/kody-hq/kody/actions/runs/99',
				}),
		},
	)
	expect(failed.exitCode).toBe(1)
	expect(logs.join('\n')).toMatch(/Preview workflow failure/)
})

test('preview manual test skips a cancelled head-SHA run and follows the newer success (#3770)', async () => {
	await using server = await createPreviewFixtureServer('headsha')
	const logs: Array<string> = []
	const cancelled = {
		databaseId: 10,
		status: 'completed',
		conclusion: 'cancelled',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/10',
		displayTitle: 'Preview #42',
	}
	const successor = {
		databaseId: 11,
		status: 'completed',
		conclusion: 'success',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/11',
		displayTitle: 'Preview #42',
	}
	// Cancelled listed first, as gh sometimes returns after concurrency cancel.
	const { exitCode, result } = await runPreviewManualTest(
		['--pr', '42', '--skip-login'],
		createSilentDeps({
			logs,
			execGh: async (args) =>
				fakeGh(args, {
					commentBody: sampleCommentWithUrl(server.origin),
					headSha: 'headsha',
					runs: [cancelled, successor],
				}),
		}),
	)

	expect(exitCode).toBe(0)
	expect(result?.ok).toBe(true)
	expect(result?.snapshot.workflowUrl).toBe(successor.url)
	expect(result?.snapshot.workflowConclusion).toBe('success')
	expect(result?.snapshot.workflowUrl).not.toBe(cancelled.url)
})

test('preview manual test keeps waiting when the only head-SHA run is cancelled (#3770)', async () => {
	let now = 0
	const logs: Array<string> = []
	const { exitCode, result } = await runPreviewManualTest(
		['--pr', '42', '--timeout-ms', '2500', '--poll-ms', '1000', '--skip-login'],
		createSilentDeps({
			logs,
			now: () => now,
			sleep: async (ms) => {
				now += ms
			},
			execGh: async (args) =>
				fakeGh(args, {
					commentBody: null,
					headSha: 'headsha',
					runs: [
						{
							databaseId: 10,
							status: 'completed',
							conclusion: 'cancelled',
							headSha: 'headsha',
							event: 'pull_request',
							url: 'https://github.com/kody-hq/kody/actions/runs/10',
							displayTitle: 'Preview #42',
						},
					],
				}),
		}),
	)

	expect(exitCode).toBe(1)
	expect(result).toBeNull()
	expect(logs.join('\n')).toMatch(/Timed out/)
	expect(logs.join('\n')).not.toMatch(/Preview workflow cancelled/)
})

test('preview manual test does not treat an older success as ready behind a newer cancelled same-SHA run', async () => {
	await using server = await createPreviewFixtureServer('headsha')
	let now = 0
	const logs: Array<string> = []
	const olderSuccess = {
		databaseId: 10,
		status: 'completed',
		conclusion: 'success',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/10',
		displayTitle: 'Preview #42',
	}
	const newerCancelled = {
		databaseId: 11,
		status: 'completed',
		conclusion: 'cancelled',
		headSha: 'headsha',
		event: 'pull_request',
		url: 'https://github.com/kody-hq/kody/actions/runs/11',
		displayTitle: 'Preview #42',
	}
	const { exitCode, result } = await runPreviewManualTest(
		['--pr', '42', '--timeout-ms', '2500', '--poll-ms', '1000', '--skip-login'],
		createSilentDeps({
			logs,
			now: () => now,
			sleep: async (ms) => {
				now += ms
			},
			execGh: async (args) =>
				fakeGh(args, {
					// Healthy old preview URL must not short-circuit the wait.
					commentBody: sampleCommentWithUrl(server.origin),
					headSha: 'headsha',
					runs: [olderSuccess, newerCancelled],
				}),
		}),
	)

	expect(exitCode).toBe(1)
	expect(result).toBeNull()
	expect(logs.join('\n')).toMatch(/Timed out/)
})

function sampleCommentWithUrl(previewUrl: string) {
	return [
		previewCommentMarker,
		`🔎 Preview deployed: ${previewUrl}`,
		'',
		'Worker: `kody-pr-42`',
	].join('\n')
}

function createSilentDeps(
	overrides: Partial<PreviewManualTestDeps> & {
		logs: Array<string>
		files?: Map<string, string>
	},
): PreviewManualTestDeps {
	const { logs, files = new Map<string, string>(), ...rest } = overrides
	return {
		execGh: async () => ({ status: 1, stdout: '', stderr: 'unused' }),
		fetch,
		sleep: async () => {
			// Tests that wait inject their own clock.
		},
		now: () => Date.now(),
		log: (message) => {
			logs.push(message)
		},
		error: (message) => {
			logs.push(message)
		},
		print: (message) => {
			logs.push(message)
		},
		writeFile: async (path, contents) => {
			files.set(path, contents)
		},
		...rest,
	}
}

function fakeGh(
	args: ReadonlyArray<string>,
	input: {
		isDraft?: boolean
		commentBody?: string | null
		headSha?: string
		runStatus?: string
		runConclusion?: string | null
		runUrl?: string
		runs?: Array<{
			databaseId: number
			status: string
			conclusion: string | null
			headSha: string
			event: string
			url: string
			displayTitle: string
		}>
		commitParents?: Array<string>
	},
): GhResult {
	const joined = args.join(' ')
	if (joined.startsWith('pr view')) {
		return jsonGh({
			number: 42,
			url: 'https://github.com/kody-hq/kody/pull/42',
			isDraft: input.isDraft === true,
			headRefOid: input.headSha ?? 'headsha',
		})
	}
	if (joined.startsWith('repo view')) {
		return jsonGh({ nameWithOwner: 'kody-hq/kody' })
	}
	if (joined.includes('/issues/') && joined.includes('/comments')) {
		const comments = input.commentBody ? [{ body: input.commentBody }] : []
		if (args.includes('--slurp')) {
			return jsonGh([comments])
		}
		return jsonGh(comments)
	}
	if (joined.startsWith('run list')) {
		if (input.runs) {
			return jsonGh(input.runs)
		}
		return jsonGh([
			{
				databaseId: 1,
				status: input.runStatus ?? 'in_progress',
				conclusion: input.runConclusion ?? null,
				headSha: input.headSha ?? 'headsha',
				event: 'pull_request',
				url: input.runUrl ?? 'https://github.com/kody-hq/kody/actions/runs/1',
				displayTitle: 'Preview #42',
			},
		])
	}
	if (joined.includes('/commits/')) {
		return jsonGh({
			sha: joined.split('/commits/')[1] ?? '',
			parents: (input.commitParents ?? []).map((sha) => ({ sha })),
		})
	}
	return { status: 1, stdout: '', stderr: `unexpected gh ${joined}` }
}

function jsonGh(value: unknown): GhResult {
	return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' }
}

async function createPreviewFixtureServer(commitSha = 'deployedsha') {
	const html = (response: ServerResponse, status: number, body: string) => {
		response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
		response.end(body)
	}
	type Handler = (request: IncomingMessage, response: ServerResponse) => void
	const requireSession =
		(handler: Handler): Handler =>
		(request, response) => {
			if (hasSessionCookie(request)) handler(request, response)
			else json(response, 401, { ok: false, error: 'Unauthorized.' })
		}
	const accountPage: Handler = (request, response) => {
		if (hasSessionCookie(request)) {
			html(response, 200, '<h1>Account</h1>')
			return
		}
		response.writeHead(302, { Location: '/login' })
		response.end()
	}
	const routes: Record<string, Handler> = {
		'GET /health': (_request, response) =>
			json(response, 200, { ok: true, commitSha }),
		'GET /login': (_request, response) =>
			html(
				response,
				200,
				'<h1>Welcome back</h1><label>Email</label><label>Password</label>',
			),
		'GET /mcp': (_request, response) => {
			response.writeHead(401, { 'WWW-Authenticate': 'Bearer' })
			response.end('unauthorized')
		},
		'POST /auth': (_request, response) => {
			response.writeHead(200, {
				'Content-Type': 'application/json',
				'Set-Cookie': 'kody_session=test-cookie; Path=/; HttpOnly',
			})
			response.end(JSON.stringify({ ok: true }))
		},
		'GET /session': (request, response) =>
			json(
				response,
				200,
				hasSessionCookie(request)
					? {
							ok: true,
							session: { email: previewSeedEmail, username: 'user-me' },
						}
					: { ok: false },
			),
		'GET /pricing': (_request, response) =>
			html(response, 200, '<h1>Pricing</h1><p>Worker compute is metered.</p>'),
		'GET /admin': (_request, response) => html(response, 403, 'forbidden'),
		'POST /account/secrets.json': requireSession((_request, response) =>
			json(response, 200, {
				ok: true,
				selectedSecretId: 'user::::previewSeed',
				secrets: [
					{
						id: 'user::::previewSeed',
						name: 'previewSeed',
						scope: 'user',
					},
				],
			}),
		),
		'GET /account/secrets.json': requireSession((_request, response) =>
			json(response, 200, {
				ok: true,
				secrets: [
					{
						id: 'user::::previewSeed',
						name: 'previewSeed',
						scope: 'user',
					},
				],
			}),
		),
		'GET /account': accountPage,
		'GET /account/secrets': accountPage,
	}
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const handler = routes[`${request.method} ${url.pathname}`]
		if (handler) {
			handler(request, response)
			return
		}
		response.writeHead(404)
		response.end('not found')
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Failed to resolve fixture server port')
	}

	const captured: Array<{ path: string; contentType: string; body: string }> =
		[]
	const record =
		(handler: Handler): Handler =>
		(request, response) => {
			const chunks: Array<Buffer> = []
			request.on('data', (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			})
			request.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8')
				captured.push({
					path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
					contentType: String(request.headers['content-type'] ?? ''),
					body,
				})
				handler(request, response)
			})
		}
	routes['POST /account/organizations/new'] = record((_request, response) => {
		const slug = new URLSearchParams(captured.at(-1)?.body ?? '').get('slug')
		response.writeHead(302, { Location: `/@${slug ?? ''}` })
		response.end()
	})
	routes['POST /account/profile/avatar.json'] = record((_request, response) => {
		json(response, 200, { ok: true, avatar: true })
	})
	const echoed: Array<{ referer?: string; accept?: string; cookie?: string }> =
		[]
	routes['GET /account/connected-agents.json'] = requireSession(
		(request, response) => {
			const seen = {
				referer: request.headers.referer,
				accept: request.headers.accept,
				cookie: request.headers.cookie,
			}
			echoed.push(seen)
			json(response, 200, { ok: true, agents: [], seen })
		},
	)

	return {
		origin: `http://127.0.0.1:${address.port}`,
		captured,
		echoed,
		async [Symbol.asyncDispose]() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'Content-Type': 'application/json' })
	response.end(JSON.stringify(body))
}

function hasSessionCookie(request: IncomingMessage) {
	return (request.headers.cookie ?? '').includes('kody_session=test-cookie')
}
