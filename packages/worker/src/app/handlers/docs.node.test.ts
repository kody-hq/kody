import { expect, test, vi } from 'vitest'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadAccessibleDocDetail,
	createDocDetailMarkdownHandler,
	createDocsConnectMarkdownHandler,
} from './docs.ts'
import { resolveLegacyGuidesLocation } from './legacy-guides-redirect.ts'

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: vi.fn(async () => null),
}))

const env = { APP_BASE_URL: 'https://kody.example' } as Env
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

function asAdminOnce() {
	vi.mocked(readAuthenticatedAppUser).mockResolvedValueOnce({
		roles: ['admin', 'user'],
	} as never)
}

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

	expect(
		(
			await call(createDocDetailMarkdownHandler, '/docs/connect.md', {
				slug: 'connect',
			})
		).status,
	).toBe(404)
})

test('doc detail handlers serve published docs and return 404 for unknown slugs', async () => {
	const markdownDetail = (slug: string) =>
		call(createDocDetailMarkdownHandler, `/docs/${slug}.md`, { slug })
	const apiDetail = (slug: string) => readDetail(slug)

	const oauthDetail = await markdownDetail('oauth')
	expect(oauthDetail.status).toBe(200)
	expect(oauthDetail.headers.get('content-type')).toBe(markdownType)

	const googleOauthApi = await apiDetail('google-oauth')
	expect(googleOauthApi).toMatchObject({
		ok: true,
		slug: 'google-oauth',
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
									style: { color: '#111', '--highlight-dark': '#eee' },
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
			{ plain: boolean; lines: Array<Array<{ content: string }>> }
		>
	}
	expect(howKodyWorksPayload.ok).toBe(true)
	expect(received?.length).toBeGreaterThan(0)
	expect(
		Object.values(howKodyWorksPayload.walkthroughHighlights ?? {}).some(
			(highlight) => !highlight.plain && highlight.lines.length > 0,
		),
	).toBe(true)
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

	const publicSubscriptions = await call(
		createDocDetailMarkdownHandler,
		'/docs/package-subscriptions.md',
		{ slug: 'package-subscriptions' },
	)
	expect(publicSubscriptions.status).toBe(200)

	const cookie = { Cookie: 'kody_session=test' }
	asAdminOnce()
	const adminJson = await readDetail(slug, env, cookie)
	expect(adminJson).toMatchObject({ ok: true, slug })

	asAdminOnce()
	const adminMarkdown = await call(
		createDocDetailMarkdownHandler,
		`/docs/${slug}.md`,
		{ slug, headers: cookie },
	)
	expect(adminMarkdown.status).toBe(200)
	expect(adminMarkdown.headers.get('Cache-Control')).toBe('no-store')
})
