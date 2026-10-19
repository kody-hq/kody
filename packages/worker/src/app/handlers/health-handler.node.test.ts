import { expect, test } from 'vitest'
import {
	encodeDeployInfo,
	type DeployInfo,
	type HealthReport,
} from '#worker/deploy-info.ts'
import {
	createHealthHandler,
	renderHealthHtml,
	safeHttpHref,
} from '#app/handlers/health.ts'

const commitSha = 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e'
const deployInfo = {
	repoUrl: 'https://github.com/kody-hq/kody',
	commit: {
		sha: commitSha,
		message: 'feat: richer /health metadata (#1799)',
		committedAt: '2026-08-27T18:00:00Z',
	},
	pullRequest: {
		number: 1799,
		url: 'https://github.com/kody-hq/kody/pull/1799',
		title: 'Richer /health metadata',
	},
	deploy: {
		deployedAt: '2026-08-27T18:05:00Z',
		environment: 'preview',
		workflow: '🔎 Preview',
		job: 'deploy',
		runId: '99',
		runUrl: 'https://github.com/kody-hq/kody/actions/runs/99',
	},
} satisfies DeployInfo

const expectedDeployedReport = {
	ok: true,
	commitSha,
	commit: {
		sha: commitSha,
		url: `https://github.com/kody-hq/kody/commit/${commitSha}`,
		message: deployInfo.commit.message,
		committedAt: deployInfo.commit.committedAt,
	},
	pullRequest: deployInfo.pullRequest,
	deploy: deployInfo.deploy,
} satisfies HealthReport

const browserAccept =
	'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const fetchAccept = '*/*'

function createHealthRequestContext(
	accept?: string,
	url = 'https://example.com/health',
) {
	return {
		request: new Request(url, {
			headers: accept ? { Accept: accept } : undefined,
		}),
	}
}

async function readJsonResponse(response: Response) {
	const contentType = response.headers.get('Content-Type')
	const cacheControl = response.headers.get('Cache-Control')
	const commitHeader = response.headers.get('X-App-Commit-Sha')
	const bodyText = await response.text()
	return {
		status: response.status,
		contentType,
		cacheControl,
		commitHeader,
		bodyText,
		body: JSON.parse(bodyText) as unknown,
	}
}

test('health JSON stays unchanged for non-browser Accept values', async () => {
	const handler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: encodeDeployInfo(deployInfo),
	})
	const accepts = [undefined, '*/*', 'application/json', fetchAccept] as const
	for (const accept of accepts) {
		const response = await handler(createHealthRequestContext(accept))
		const json = await readJsonResponse(response)
		expect(json).toEqual({
			status: 200,
			contentType: 'application/json',
			cacheControl: 'no-store',
			commitHeader: commitSha,
			bodyText: JSON.stringify(expectedDeployedReport),
			body: expectedDeployedReport,
		})
	}
})

test('health handler reports commit, PR, and deploy metadata for JSON and HTML clients', async () => {
	const unsetHandler = createHealthHandler({
		APP_COMMIT_SHA: undefined,
		APP_DEPLOY_INFO: undefined,
	})
	const unsetResponse = await unsetHandler(createHealthRequestContext())
	expect(unsetResponse.status).toBe(200)
	expect(unsetResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(unsetResponse.headers.get('X-App-Commit-Sha')).toBe('unknown')
	expect(await unsetResponse.json()).toEqual({
		ok: true,
		commitSha: null,
		commit: null,
		pullRequest: null,
		deploy: null,
	})

	const shaOnlyHandler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: undefined,
	})
	const shaOnlyResponse = await shaOnlyHandler(
		createHealthRequestContext('application/json'),
	)
	expect(shaOnlyResponse.headers.get('X-App-Commit-Sha')).toBe(commitSha)
	expect(await shaOnlyResponse.json()).toEqual({
		ok: true,
		commitSha,
		commit: {
			sha: commitSha,
			url: `https://github.com/kody-hq/kody/commit/${commitSha}`,
			message: null,
			committedAt: null,
		},
		pullRequest: null,
		deploy: null,
	})

	const deployedHandler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: encodeDeployInfo(deployInfo),
	})
	const jsonResponse = await deployedHandler(createHealthRequestContext())
	expect(await jsonResponse.json()).toEqual(expectedDeployedReport)

	const htmlResponse = await deployedHandler(
		createHealthRequestContext(browserAccept),
	)
	expect(htmlResponse.headers.get('Content-Type')).toBe(
		'text/html; charset=utf-8',
	)
	expect(htmlResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(htmlResponse.headers.get('X-App-Commit-Sha')).toBe(commitSha)
	const html = await htmlResponse.text()
	expect(html).toContain('prefers-color-scheme')
	expect(html).toContain('status-ok')
	expect(html).toContain('Healthy')
	expect(html).toContain(commitSha)
	expect(html).toContain(`https://github.com/kody-hq/kody/commit/${commitSha}`)
	expect(html).toContain(deployInfo.pullRequest.url)
	expect(html).toContain(deployInfo.deploy.runUrl)
	expect(html).toContain(deployInfo.commit.message)
	expect(html).toContain('href="?format=json"')
	expect(html).toContain('<details>')
	expect(html).toContain('&quot;ok&quot;: true')
})

test('?format=json returns JSON even when Accept prefers HTML', async () => {
	const handler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: encodeDeployInfo(deployInfo),
	})
	const response = await handler(
		createHealthRequestContext(
			browserAccept,
			'https://example.com/health?format=json',
		),
	)
	const json = await readJsonResponse(response)
	expect(json).toEqual({
		status: 200,
		contentType: 'application/json',
		cacheControl: 'no-store',
		commitHeader: commitSha,
		bodyText: JSON.stringify(expectedDeployedReport),
		body: expectedDeployedReport,
	})
})

test('health HTML escapes hostile field values and refuses non-http hrefs', async () => {
	const hostile = {
		repoUrl: 'https://github.com/kody-hq/kody',
		commit: {
			sha: commitSha,
			message: '<script>alert(1)</script> & "quotes"',
			committedAt: '2026-08-27T18:00:00Z',
		},
		pullRequest: {
			number: 42,
			url: 'javascript:alert(1)',
			title: '<img src=x onerror=alert(1)>',
		},
		deploy: {
			deployedAt: '2026-08-27T18:05:00Z',
			environment: '<b>prod</b>',
			workflow: 'Deploy',
			job: 'deploy',
			runId: '1',
			runUrl: 'data:text/html,<script>alert(1)</script>',
		},
	} satisfies DeployInfo

	const handler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: encodeDeployInfo(hostile),
	})
	const html = await (
		await handler(createHealthRequestContext(browserAccept))
	).text()

	expect(html).not.toContain('<script>alert(1)</script>')
	expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
	expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
	expect(html).toContain('&lt;b&gt;prod&lt;/b&gt;')
	expect(html).not.toContain('href="javascript:')
	expect(html).not.toContain("href='javascript:")
	expect(html).not.toContain('href="data:')
	expect(html).toContain('#42 &lt;img src=x onerror=alert(1)&gt;')
	// Unsafe URLs may appear as escaped text in the raw JSON <details>, but
	// never as live href attributes.
	expect(html).toMatch(/<dd>#42 &lt;img src=x onerror=alert\(1\)&gt;<\/dd>/)
	expect(html).toMatch(
		/<dd>data:text\/html,&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/dd>/,
	)
})

test('renderHealthHtml shows an unhealthy status when ok is false', () => {
	const html = renderHealthHtml({
		ok: false,
		commitSha: null,
		commit: null,
		pullRequest: null,
		deploy: null,
	})
	expect(html).toContain('class="status status-bad"')
	expect(html).toContain('Unhealthy')
	expect(html).not.toContain('class="status status-ok"')
	expect(html).toContain('unset')
})

test('safeHttpHref only allows http(s) URLs', () => {
	expect(safeHttpHref('https://example.com/a')).toBe('https://example.com/a')
	expect(safeHttpHref('http://127.0.0.1/health')).toBe(
		'http://127.0.0.1/health',
	)
	expect(safeHttpHref('javascript:alert(1)')).toBeNull()
	expect(safeHttpHref('data:text/html,hi')).toBeNull()
	expect(safeHttpHref('not a url')).toBeNull()
})
