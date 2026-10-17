import { buildOpenApiDiscoveryMarkdown } from '#app/agent-discovery.ts'
import {
	listPublicWebsitePages,
	listPublicBlogPages,
} from '#app/public-content.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getGuideBySlug,
	getIntroGuide,
	listGuidesBySection,
	listProviderGuides,
} from '#worker/guides/catalog.ts'
import { markdownResponse } from '#app/markdown-negotiation.ts'
import { docMarkdownHref, resolveLegacyDocSlug } from '#universal/docs-nav.ts'
import { anonymousPersonalizedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import { requestIsDocsAdmin, viewerCanAccessGuide } from '#app/docs-access.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { parseOgTheme } from '#worker/og/palette.ts'
import {
	highlightMarkdownFences,
	highlightResultsByKey,
	highlightSnippets,
	uniqueHighlightSnippets,
} from '#app/highlight-code.ts'
import { collectGoogleOauthSnippets } from '#universal/google-oauth-transcript.ts'
import { collectHowKodyWorksSnippets } from '#universal/how-kody-works-transcript.ts'
import { type DocDetailLoaderData } from '#universal/loader-data.ts'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { type Guide } from '#worker/guides/parse-frontmatter.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'

function appendDocMarkdownLinks(
	lines: Array<string>,
	guides: ReadonlyArray<Guide>,
	baseUrl: string,
) {
	for (const guide of guides) {
		lines.push(
			`- [${guide.title}](${baseUrl}${docMarkdownHref(guide.slug)}) — ${guide.summary}`,
		)
	}
}

/**
 * Sectioned index of every advertised doc, shared by `/docs.md` (after the
 * introduction) and `/llms.txt`.
 */
export function buildDocsIndexSections(baseUrl: string): Array<string> {
	const lines: Array<string> = []
	for (const { section, guides } of listGuidesBySection()) {
		if (guides.length === 0) continue
		lines.push(`## ${section.label}`, '', section.description, '')
		appendDocMarkdownLinks(lines, guides, baseUrl)
		lines.push('')
	}
	return lines
}

/**
 * `/docs.md`: the introduction article followed by the full sectioned index,
 * so an agent that fetches the docs root gets both the pitch and a map.
 */
export function buildDocsIndexMarkdown(baseUrl: string): string {
	const intro = getIntroGuide()
	const lines = [
		intro.body.trimEnd(),
		'',
		'---',
		'',
		'# All Kody docs',
		'',
		'Every page is plain markdown at `/docs/<slug>.md` (or send',
		'`Accept: text/markdown` to the HTML URL) and available over MCP as',
		'`search({ entity: "guide:{id}" })`. Compact index:',
		`[${baseUrl}/llms.txt](${baseUrl}/llms.txt).`,
		'',
		buildOpenApiDiscoveryMarkdown(baseUrl).trimEnd(),
		'',
		...buildDocsIndexSections(baseUrl),
	]
	return lines.join('\n')
}

function publicContentLinks(
	baseUrl: string,
	pages: ReturnType<typeof listPublicWebsitePages>,
) {
	const singleLine = (text: string) => text.replace(/\s+/g, ' ').trim()
	const label = (text: string) => singleLine(text).replace(/[\\[\]]/g, '\\$&')
	return pages.map(
		(page) =>
			`- [${label(page.title)}](${baseUrl}${page.path}): ${singleLine(page.description)}`,
	)
}

/** Docs, public website pages, and blog posts share their source metadata. */
export function buildLlmsTxt(baseUrl: string): string {
	const lines = [
		'# Kody',
		'',
		"> Kody is Your agents' cloud for individuals and teams (orgs, teams,",
		'> grants): connect the AI agent you already use over MCP and it gains',
		'> durable memory, credentials it never reads, saved packages, jobs,',
		'> workflows, webhooks, and apps that keep running while you are offline,',
		'> and every other agent you connect reuses the same home.',
		'',
		`Start with [What is Kody?](${baseUrl}/docs.md). Each documentation link below is`,
		'plain markdown; the same content is available to connected agents as',
		'`search({ entity: "guide:{id}" })`.',
		'',
		buildOpenApiDiscoveryMarkdown(baseUrl).trimEnd(),
		'',
		...buildDocsIndexSections(baseUrl),
		'## Website',
		'',
		...publicContentLinks(baseUrl, listPublicWebsitePages()),
		'',
		'## Blog posts',
		'',
		...publicContentLinks(baseUrl, listPublicBlogPages()),
		'',
	]
	return lines.join('\n')
}

/**
 * `/docs/connect.md` — verified provider walkthroughs, with a path back to
 * the introduction for people who landed on connect first.
 */
export function buildDocsConnectMarkdown(baseUrl: string): string {
	const lines = [
		'# Connect a provider',
		'',
		'Verified walkthroughs for connecting Discord, GitHub, Google, Notion,',
		'Origin, Salesforce, Slack, or Spotify to Kody. Each doc covers console',
		'steps, endpoints, scopes, gotchas, and a smoke test.',
		'',
		'Looking for how Kody works instead? Start with',
		`[What is Kody?](${baseUrl}/docs.md) or`,
		`[How Kody works](${baseUrl}${docMarkdownHref('how-kody-works')}).`,
		'',
		'## Provider docs',
		'',
	]
	appendDocMarkdownLinks(lines, listProviderGuides(), baseUrl)
	lines.push(
		'',
		'## Related',
		'',
		`- [Integration bootstrap](${baseUrl}${docMarkdownHref('integration-bootstrap')}) — the sequence before any provider-backed package`,
		`- [OAuth (bring your own app)](${baseUrl}${docMarkdownHref('oauth')}) — the standard \`/connect/oauth\` path for providers without a walkthrough`,
		`- [Connect a home MCP server](${baseUrl}${docMarkdownHref('local-mcp-tunnels')}) — run a local MCP process and connect it to Kody`,
		`- [Lock an MCP server to a package](${baseUrl}${docMarkdownHref('locked-mcp-server')}) — keep a connected server's tools off execute and other packages`,
		'',
	)
	return lines.join('\n')
}

function collectWalkthroughSnippets(slug: string) {
	switch (slug) {
		case 'how-kody-works':
			return collectHowKodyWorksSnippets()
		case 'google-oauth':
			return collectGoogleOauthSnippets()
		default:
			return []
	}
}

export async function highlightWalkthrough(
	env: Env,
	slug: string,
	serverTiming?: Array<ServerTimingEntry>,
) {
	const snippets = uniqueHighlightSnippets(collectWalkthroughSnippets(slug))
	if (snippets.length === 0) return undefined
	return highlightResultsByKey(
		snippets,
		await highlightSnippets(env, snippets, { serverTiming }),
	)
}

export async function toDocDetail(
	env: Env,
	guide: Guide,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<DocDetailLoaderData> {
	const [bodyFences, walkthroughHighlights] = await Promise.all([
		highlightMarkdownFences(env, guide.body, { serverTiming }),
		highlightWalkthrough(env, guide.slug, serverTiming),
	])
	return {
		ok: true,
		slug: guide.slug,
		id: guide.id,
		title: guide.title,
		summary: guide.summary,
		category: guide.category,
		audience: guide.audience,
		image: guide.image,
		imageAlt: guide.imageAlt,
		ogImage: guide.ogImage,
		provider: guide.provider,
		lastVerified: guide.lastVerified,
		body: guide.body,
		bodyFences,
		...(walkthroughHighlights ? { walkthroughHighlights } : {}),
		...(guide.slug === 'how-kody-works'
			? { walkthroughHosts: pickWalkthroughHosts() }
			: {}),
	}
}

function permanentRedirect(location: string): Response {
	return new Response(null, {
		status: 308,
		headers: { Location: location, 'Cache-Control': 'public, max-age=3600' },
	})
}

function withSearch(pathname: string, request: Request): string {
	return `${pathname}${new URL(request.url).search}`
}

export function docDetailRedirect(
	slug: string,
	request: Request,
	twin: '' | '.md' | '.json' | '/og.png',
): Response | null {
	const alias = resolveLegacyDocSlug(slug)
	if (alias.slug === slug) return null
	const fragment = twin === '' && alias.fragment ? `#${alias.fragment}` : ''
	return permanentRedirect(
		`${withSearch(`/docs/${alias.slug}${twin}`, request)}${fragment}`,
	)
}

export async function missingDocResponse(
	kind: 'markdown' | 'json',
): Promise<Response> {
	if (kind === 'markdown') {
		return markdownResponse('# Doc not found\n', 404)
	}
	return jsonResponse({ ok: false, error: 'Doc not found.' }, 404)
}

export async function resolveAccessibleGuide(
	request: Request,
	env: Env,
	slug: string,
): Promise<Guide | null> {
	const guide = getGuideBySlug(slug)
	if (!guide) return null
	if (!guide.adminOnly) return guide
	const isAdmin = await requestIsDocsAdmin(request, env)
	return viewerCanAccessGuide(guide, isAdmin) ? guide : null
}

/** Shared data boundary for native website reads and public markdown. */
export async function loadAccessibleDocDetail(
	request: Request,
	env: Env,
	slug: string,
	serverTiming?: Array<ServerTimingEntry>,
) {
	const guide = await resolveAccessibleGuide(request, env, slug)
	if (!guide) return null
	return {
		doc: await toDocDetail(env, guide, serverTiming),
		adminOnly: guide.adminOnly,
	}
}

export function guideMarkdownResponse(guide: Guide): Response {
	const response = markdownResponse(guide.body)
	if (guide.adminOnly) {
		response.headers.set('Cache-Control', 'no-store')
	}
	return response
}

export function createDocsMarkdownHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
		return markdownResponse(buildDocsIndexMarkdown(baseUrl))
	}
}

function llmsTxtResponse(env: Env, request: Request): Response {
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	return new Response(buildLlmsTxt(baseUrl), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			...anonymousPersonalizedJsonCacheHeaders({
				personalized: false,
				request,
			}),
		},
	})
}

export function createLlmsTxtHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		return llmsTxtResponse(env, request)
	}
}

export function createDocsLlmsTxtHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		return llmsTxtResponse(env, request)
	}
}

export function createDocsConnectMarkdownHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
		return markdownResponse(buildDocsConnectMarkdown(baseUrl))
	}
}

export function createDocDetailMarkdownHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { slug: string }
	}) => {
		const redirect = docDetailRedirect(params.slug, request, '.md')
		if (redirect) return redirect
		const guide = await resolveAccessibleGuide(request, env, params.slug)
		if (!guide) {
			return missingDocResponse('markdown')
		}
		return guideMarkdownResponse(guide)
	}
}

export function createDocDetailOgImageHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { slug: string }
	}) => {
		const redirect = docDetailRedirect(params.slug, request, '/og.png')
		if (redirect) return redirect
		const guide = await resolveAccessibleGuide(request, env, params.slug)
		const ogImage = guide?.ogImage ?? guide?.image
		if (!guide || !ogImage) {
			return new Response('Not found', { status: 404 })
		}

		const imageResponse = await env.ASSETS.fetch(
			new Request(new URL(ogImage, request.url)),
		)
		if (!imageResponse.ok) {
			return new Response('Doc artwork unavailable', { status: 502 })
		}
		const contentType =
			imageResponse.headers.get('content-type') ?? 'image/webp'
		const imageDataUri = `data:${contentType};base64,${bytesToBase64(
			new Uint8Array(await imageResponse.arrayBuffer()),
		)}`
		const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

		// Deployment requires this lazy boundary: eagerly importing Satori and
		// Resvg makes the main Worker exceed Cloudflare's startup CPU limit.
		const { renderGuideOgImage } = await import('#worker/guides/og-image.ts')
		const png = await renderGuideOgImage({
			title: guide.title,
			description: guide.summary,
			imageDataUri,
			theme,
			assets: env.ASSETS,
		})

		return new Response(png, {
			status: 200,
			headers: {
				'Cache-Control': guide.adminOnly ? 'no-store' : 'public, max-age=3600',
				'Content-Type': 'image/png',
			},
		})
	}
}
