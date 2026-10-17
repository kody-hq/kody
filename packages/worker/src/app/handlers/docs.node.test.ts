import { listPublicSitemapEntries } from '#app/agent-discovery.ts'
import {
	listPublicWebsitePages,
	listPublicBlogPages,
} from '#app/public-content.ts'
import { expect, test, vi } from 'vitest'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import { howKodyWorksPackageFiles } from '#universal/how-kody-works-transcript.ts'
import {
	isValidWalkthroughHostPick,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { getGuideBySlug, listProviderGuides } from '#worker/guides/catalog.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadAccessibleDocDetail,
	createDocDetailMarkdownHandler,
	createDocsConnectMarkdownHandler,
	createDocsMarkdownHandler,
	createLlmsTxtHandler,
	createDocsLlmsTxtHandler,
} from './docs.ts'
import { resolveLegacyGuidesLocation } from './legacy-guides-redirect.ts'

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: vi.fn(async () => null),
}))

const env = { APP_BASE_URL: 'https://kody.example' } as Env
const publicCache = 'public, max-age=60, stale-while-revalidate=300'
const markdownType = 'text/markdown; charset=utf-8'

type HandlerArgs = { request: Request; params: { slug: string } }

function call(
	create: (env: Env) => (args: HandlerArgs) => Promise<Response>,
	path: string,
	options: { slug?: string; headers?: HeadersInit; env?: Env } = {},
) {
	const action = create(options.env ?? env)
	return action({
		request: new Request(`https://kody.example${path}`, {
			headers: options.headers,
		}),
		params: { slug: options.slug ?? '' },
	})
}

async function readDetail(
	slug: string,
	bindings: Env = env,
	headers?: HeadersInit,
) {
	const detail = await loadAccessibleDocDetail(
		new Request(`https://kody.example/docs/${slug}`, { headers }),
		bindings,
		slug,
	)
	return detail?.doc ?? null
}

function expectOrdered(body: string, markers: Array<string>) {
	const positions = markers.map((marker) => body.indexOf(marker))
	expect(positions.every((position) => position >= 0)).toBe(true)
	expect(positions).toEqual([...positions].sort((a, b) => a - b))
}

function asAdminOnce() {
	vi.mocked(readAuthenticatedAppUser).mockResolvedValueOnce({
		roles: ['admin', 'user'],
	} as never)
}

test('the markdown root is intro plus index', async () => {
	const markdownIndex = await call(createDocsMarkdownHandler, '/docs.md')
	expect(markdownIndex.headers.get('content-type')).toBe(markdownType)
	const indexBody = await markdownIndex.text()
	expect(indexBody).toContain('https://kody.example/llms.txt')
	expect(indexBody).toContain('## Kody Open API')
	expect(indexBody).toContain('https://api.kody.codes/openapi.json')
	expect(indexBody).toContain('https://api-docs.kody.codes/')
	expect(indexBody).toContain('/docs/open-api.md')
	expect(indexBody).toContain('/docs/api-versioning.md')
	expect(indexBody).toContain('## Examples')
	expect(indexBody).toContain('/docs/flake-hunter.md')
	expectOrdered(indexBody, ['## Introduction', '## Get started'])
	expectOrdered(indexBody, [
		'/docs/what-is-kody.md',
		'/docs/search-and-execute.md',
		'/docs/how-kody-works.md',
	])
	expectOrdered(indexBody, ['## Concepts', '## Connect a provider'])
	for (const hidden of [
		'https://kody.example/docs/values.md',
		'/docs/admin-events.md',
		'## Admin',
	]) {
		expect(indexBody).not.toContain(hidden)
	}

	const llms = await call(createLlmsTxtHandler, '/llms.txt')
	expect(llms.status).toBe(200)
	expect(llms.headers.get('content-type')).toBe('text/plain; charset=utf-8')
	expect(llms.headers.get('Cache-Control')).toBe(publicCache)
	expect(llms.headers.get('Vary')).toBe('Cookie')
	const llmsBody = await llms.text()
	expect(llmsBody.startsWith('# Kody\n')).toBe(true)
	expect(llmsBody).toContain('individuals and teams')
	expect(llmsBody).toContain('credentials it never reads')
	expect(llmsBody).toContain('## Kody Open API')
	expect(llmsBody).toContain('https://api.kody.codes/openapi.json')
	expect(llmsBody).toContain('https://api-docs.kody.codes/')
	expect(llmsBody).toContain('/docs/api-versioning.md')
	expect(llmsBody).toContain('Kody Docs')
	expect(llmsBody).not.toContain('/docs/values.md')
	expect(llmsBody).not.toContain('/docs/admin-events.md')
	expectOrdered(llmsBody, [
		'/docs/what-is-kody.md',
		'/docs/search-and-execute.md',
		'/docs/how-kody-works.md',
	])
})

test('legacy /guides URLs resolve to their /docs twins and merged doc slugs 308 on every twin', async () => {
	const cases: Array<[string, string]> = [
		['/guides', '/docs'],
		['/guides.md', '/docs.md'],
		['/guides.json', '/docs.json'],
		['/guides/connect', '/docs/connect'],
		['/guides/connect.md', '/docs/connect.md'],
		['/guides/connect.json', '/docs/connect.json'],
		['/guides/what-is-kody', '/docs/what-is-kody'],
		['/guides/what-is-kody.md', '/docs/what-is-kody.md'],
		['/guides/oauth', '/docs/oauth'],
		['/guides/oauth.md', '/docs/oauth.md'],
		['/guides/oauth.json', '/docs/oauth.json'],
		['/guides/kody-factory/og.png', '/docs/kody-factory/og.png'],
		['/guides/oauth?utm=x', '/docs/oauth?utm=x'],
		[
			'/guides/integration-backed-app-happy-path',
			'/docs/package-apps#after-an-integration-smoke-test',
		],
		['/guides/integration-backed-app-happy-path.md', '/docs/package-apps.md'],
		[
			'/guides/webhooks',
			'/docs/triggers#inbound-webhooks-the-external-http-knock',
		],
		['/guides/webhooks.md', '/docs/triggers.md'],
		['/guides/nope', '/docs/nope'],
	]
	expect(
		cases.map(([from]) => [
			from,
			resolveLegacyGuidesLocation(new URL(from, 'https://kody.example')),
		]),
	).toEqual(cases)

	const slug = 'integration-backed-app-happy-path'
	for (const [create, ext] of [
		[createDocDetailMarkdownHandler, 'md'],
	] as const) {
		const response = await call(create, `/docs/${slug}.${ext}`, { slug })
		expect(response.status).toBe(308)
		expect(response.headers.get('Location')).toBe(`/docs/package-apps.${ext}`)
	}
})

test('docs connect markdown stays separate from doc slugs', async () => {
	const markdown = await call(
		createDocsConnectMarkdownHandler,
		'/docs/connect.md',
	)
	expect(markdown.status).toBe(200)
	expect(markdown.headers.get('content-type')).toBe(markdownType)
	const body = await markdown.text()
	expect(body.startsWith('#')).toBe(true)
	const linked = [
		'docs',
		'docs/how-kody-works',
		'docs/local-mcp-tunnels',
		'docs/locked-mcp-server',
		'docs/integration-bootstrap',
		...listProviderGuides().map((guide) => `docs/${guide.slug}`),
	].map((path) => `https://kody.example/${path}.md`)
	expect(linked.filter((url) => !body.includes(url))).toEqual([])

	// Reserved `connect` is an index route, not a guide detail slug. The
	// dedicated markdown handler is what routers register for
	// `/docs/connect.md`; the detail handler would 404 if somehow matched.
	expect(getGuideBySlug('connect')).toBeNull()
	expect(
		(
			await call(createDocDetailMarkdownHandler, '/docs/connect.md', {
				slug: 'connect',
			})
		).status,
	).toBe(404)
})

test('provider and platform doc markdown details stay stable', async () => {
	const markdownDetail = (slug: string) =>
		call(createDocDetailMarkdownHandler, `/docs/${slug}.md`, { slug })
	const apiDetail = (slug: string) => readDetail(slug)

	for (const slug of ['oauth', 'github', 'google-oauth']) {
		expect([slug, (await markdownDetail(slug)).status]).toEqual([slug, 200])
	}
	const oauthDetail = await markdownDetail('oauth')
	expect(oauthDetail.headers.get('content-type')).toBe(markdownType)
	const oauthBody = await oauthDetail.text()
	expect(oauthBody.startsWith('#')).toBe(true)
	expect(oauthBody).not.toContain('\nid: oauth\n')

	const googleOauthApi = await apiDetail('google-oauth')
	expect(googleOauthApi).toMatchObject({
		ok: true,
		slug: 'google-oauth',
		id: 'google_oauth',
	})
	expect(await apiDetail('kody-factory')).toMatchObject({
		ok: true,
		slug: 'kody-factory',
		id: 'kody_factory',
	})

	expect((await markdownDetail('nope')).status).toBe(404)
	expect(await apiDetail('nope')).toBeNull()
})

test('interactive doc JSON includes walkthrough highlight tokens', async () => {
	let received: Array<{ code: string; lang?: string | null }> | undefined
	const highlightEnv = {
		APP_BASE_URL: 'https://kody.example',
		HIGHLIGHT: {
			fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					snippets: Array<{ code: string; lang?: string | null }>
				}
				received = body.snippets
				return Response.json({
					results: body.snippets.map((snippet) => ({
						code: snippet.code,
						lang: snippet.lang ?? 'plaintext',
						plain: false,
						lines: [
							[
								{
									content: snippet.code,
									style: { color: '#111', '--shiki-dark': '#eee' },
								},
							],
						],
					})),
				})
			},
		} as unknown as Fetcher,
	} as Env
	const apiDetail = (slug: string) => readDetail(slug, highlightEnv)
	const howKodyWorksResponse = await apiDetail('how-kody-works')
	const howKodyWorksPayload = howKodyWorksResponse as {
		ok: boolean
		walkthroughHighlights?: Record<
			string,
			{ plain: boolean; lines: Array<Array<{ style?: { color?: string } }>> }
		>
		walkthroughHosts?: WalkthroughHostPick
	}
	expect(howKodyWorksPayload.ok).toBe(true)
	expect(received?.length).toBeGreaterThan(0)
	const packageJsonKey = highlightSnippetKey({
		code: howKodyWorksPackageFiles['package.json'],
		lang: 'json',
	})
	expect(
		howKodyWorksPayload.walkthroughHighlights?.[packageJsonKey],
	).toMatchObject({ plain: false, lines: [[{ style: { color: '#111' } }]] })
	expect(howKodyWorksPayload.walkthroughHosts).toBeDefined()
	expect(
		isValidWalkthroughHostPick(howKodyWorksPayload.walkthroughHosts!),
	).toBe(true)

	const googleOauthPayload = (await apiDetail('google-oauth')) as {
		walkthroughHighlights?: Record<string, { plain: boolean }>
		walkthroughHosts?: unknown
	}
	const googleOauthHighlights = Object.values(
		googleOauthPayload.walkthroughHighlights ?? {},
	)
	expect(googleOauthHighlights.length).toBeGreaterThan(0)
	expect(googleOauthHighlights.every((entry) => entry.plain === false)).toBe(
		true,
	)
	expect(googleOauthPayload.walkthroughHosts).toBeUndefined()

	const oauthPayload = (await apiDetail('oauth')) as {
		walkthroughHighlights?: Record<string, unknown>
	}
	expect(oauthPayload.walkthroughHighlights).toBeUndefined()
})

test('admin-only docs 404 for anonymous viewers and stay out of public subscriptions', async () => {
	const slug = 'admin-events'
	expect(await readDetail(slug)).toBeNull()
	const markdown = await call(
		createDocDetailMarkdownHandler,
		`/docs/${slug}.md`,
		{ slug },
	)
	expect(markdown.status).toBe(404)
	expect(await markdown.text()).toBe('# Doc not found\n')

	const publicSubscriptions = await call(
		createDocDetailMarkdownHandler,
		'/docs/package-subscriptions.md',
		{ slug: 'package-subscriptions' },
	)
	expect(publicSubscriptions.status).toBe(200)
	expect(await publicSubscriptions.text()).toContain('run.error.recorded')

	const cookie = { Cookie: 'kody_session=test' }
	asAdminOnce()
	const adminJson = await readDetail(slug, env, cookie)
	expect(adminJson).toMatchObject({
		ok: true,
		slug,
		body: expect.stringContaining('fleet.entitlement.crossed'),
	})

	asAdminOnce()
	const adminMarkdown = await call(
		createDocDetailMarkdownHandler,
		`/docs/${slug}.md`,
		{ slug, headers: cookie },
	)
	expect(adminMarkdown.status).toBe(200)
	expect(adminMarkdown.headers.get('Cache-Control')).toBe('no-store')
	expect(await adminMarkdown.text()).toContain('fleet.entitlement.crossed')
})

test('AI discovery covers every sitemap URL and shares website and blog metadata', async () => {
	const response = await call(createLlmsTxtHandler, '/llms.txt')
	const body = await response.text()
	const alias = await call(createDocsLlmsTxtHandler, '/docs/llms.txt')
	expect(await alias.text()).toBe(body)
	const links = [...body.matchAll(/\]\(https:\/\/kody\.example([^)]*)\)/g)].map(
		(match) => match[1],
	)
	for (const entry of listPublicSitemapEntries()) {
		const path =
			entry.path.startsWith('/docs/') && entry.path !== '/docs/connect'
				? `${entry.path}.md`
				: entry.path
		expect(links).toContain(path)
	}
	for (const page of [...listPublicWebsitePages(), ...listPublicBlogPages()]) {
		expect(body).toContain(page.description.replace(/\s+/g, ' ').trim())
	}
	for (const path of [
		'/login',
		'/signup',
		'/reset-password',
		'/docs/admin-events.md',
	]) {
		expect(links).not.toContain(path)
	}
	expect(
		new Set(listPublicSitemapEntries().map((entry) => entry.path)).size,
	).toBe(listPublicSitemapEntries().length)
})
