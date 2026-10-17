import { landingHeroPrimaryCta } from '#universal/landing-home-copy.ts'
import { expect, test } from 'vitest'
import { acquisitionPages } from '#universal/acquisition/catalog.ts'
import { getGuideBySlug } from '#worker/guides/catalog.ts'
import { landingTestimonialsStorySlug } from '#universal/landing-testimonials.ts'
import {
	getBlogPost,
	getReadNextBlogPost,
	listBlogPosts,
} from '#worker/blog/catalog.ts'
import {
	createMcpClient,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../tools/mcp-test-support.ts'
import { loginToApp } from '../../../tools/mcp-oauth-client.ts'

async function document(path: string, cookie?: string) {
	const server = await getSharedMcpE2eServer()
	const url = new URL(path, server.origin)
	const response = await fetch(url, {
		headers: cookie ? { Cookie: cookie } : {},
		redirect: 'manual',
	})
	expect(response.status, `HTML ${url.href}`).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = (await response.text())
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
	expect(html).toContain('</html>')
	return { html, response, url }
}

function contains(html: string, markers: string[]) {
	for (const marker of markers) expect(html).toContain(marker)
}

test('native document middleware preserves complete SSR streams on public and personalized requests', async () => {
	const server = await getSharedMcpE2eServer()
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	const cookie = await loginToApp(server.origin, user)
	// These requests pass through the built Start middleware pipeline. Its
	// ownership reconciler must not dispose SSR when cache delivery wraps it.
	for (const headers of [new Headers(), new Headers({ Cookie: cookie })]) {
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await fetch(new URL('/faq', server.origin), { headers })
			expect(response.status).toBe(200)
			const html = await response.text()
			expect(html).toContain('</html>')
			expect(html).toContain('data-faq="replace-agents"')
			const nonce = response.headers
				.get('Content-Security-Policy')
				?.match(/'nonce-([^']+)'/)?.[1]
			expect(nonce).toBeTruthy()
			expect(html).toContain(`nonce="${nonce}"`)
		}
	}
})

test('legacy team Secrets redirects to native Credentials and Agents remains authorized', async () => {
	const server = await getSharedMcpE2eServer()
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	const cookie = await loginToApp(server.origin, user)
	const slug = `team-${user.username}`
	await using mcp = await createMcpClient(server.origin, user, {
		markEmailVerified: server.markEmailVerified,
		clearAuthRateLimits: server.clearAuthRateLimits,
	})
	const created = await mcp.client.callTool({
		name: 'execute',
		arguments: {
			code: `import { kody } from 'kody:runtime'
export default async function main(input) {
	return await kody.orgCreate({ slug: input.slug, display_name: 'Native team' })
}`,
			params: { slug },
		},
	})
	expect(created.isError).not.toBe(true)
	expect(created.structuredContent).toMatchObject({ result: { org: { slug } } })
	const legacy = await fetch(`${server.origin}/@${slug}/-/secrets`, {
		headers: { Cookie: cookie },
		redirect: 'manual',
	})
	expect(legacy.status).toBe(302)
	const credentialsPath = `/@${slug}/-/credentials?kind=secret`
	expect(legacy.headers.get('Location')).toBe(credentialsPath)
	const anonymous = await fetch(new URL(credentialsPath, server.origin), {
		redirect: 'manual',
	})
	expect(anonymous.status).toBe(302)
	expect(
		new URL(anonymous.headers.get('Location')!, server.origin).pathname,
	).toBe('/login')
	for (const [section, heading] of [
		['credentials?kind=secret', 'Credentials'],
		['agents', 'Agents'],
	]) {
		const { html } = await document(`/@${slug}/-/${section}`, cookie)
		expect(html).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`))
		expect(html).toContain('Native team')
		expect(html).not.toContain('data-testid="internal-error-page"')
	}
})

test('FAQ and support initial documents expose signup, disclosures and support links', async () => {
	const { html: faq } = await document('/faq')
	expect(faq).toMatch(/<title[^>]*>FAQ<\/title>/)
	contains(faq, [
		'data-faq="replace-agents"',
		'data-faq="shared-account"',
		'data-faq="get-started"',
		'<details',
		'<summary',
		'mailto:support@kody.codes',
		'Create a free account from',
		'href="/signup"',
		'href="/faq"',
	])
	const { html: support } = await document('/support')
	expect(support).toMatch(/<title[^>]*>Support<\/title>/)
	contains(support, ['mailto:support@kody.codes', 'href="/support"'])
})

test('Discord initial document has one accessible connect button', async () => {
	const { html } = await document('/discord')
	expect(html).toMatch(/<title[^>]*>Discord<\/title>/)
	expect(html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0]).toContain('Discord')
	expect(
		(html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).filter((button) =>
			button.includes('Connect Discord'),
		),
	).toHaveLength(1)
})

test('acquisition documents preserve canonical metadata, guide links, sitemap and Markdown twins', async () => {
	const server = await getSharedMcpE2eServer()
	const sitemap = await (await fetch(`${server.origin}/sitemap.xml`)).text()
	for (const page of acquisitionPages) {
		const { html, response, url } = await document(page.path)
		expect(response.headers.get('Vary')).toMatch(/accept/i)
		contains(html, [
			`href="${url.href}"`,
			'href="/onboarding"',
			'id="try-it"',
			'aria-pressed="true"',
		])
		expect(html).not.toMatch(/aria-pressed(?:\s|>)/)
		for (const [, slug] of html.matchAll(/href="\/docs\/([^"#?]+)[^"]*"/g))
			expect(getGuideBySlug(slug!), `${page.path}: ${slug}`).toBeTruthy()
		expect(sitemap).toContain(`<loc>${url.href}</loc>`)
		for (const source of page.sources.filter((source) =>
			source.href.startsWith('/docs/'),
		))
			expect(getGuideBySlug(source.href.slice('/docs/'.length))).toBeTruthy()
		const markdown = await fetch(url, { headers: { Accept: 'text/markdown' } })
		expect(markdown.status, `Markdown ${url.href}`).toBe(200)
		expect(markdown.headers.get('Content-Type'), `Markdown ${url.href}`).toBe(
			'text/markdown; charset=utf-8',
		)
		expect(await markdown.text()).toContain('# ')
	}
})

test('use-case index exposes its landing pages in HTML and Markdown', async () => {
	const { html, url } = await document('/use-cases')
	contains(html, [
		`href="${url.href}"`,
		'href="/compare/n8n-alternatives"',
		'href="/use-cases/mcp-gateway"',
	])
	const markdown = await fetch(url, { headers: { Accept: 'text/markdown' } })
	expect(markdown.status, `Markdown ${url.href}`).toBe(200)
	expect(await markdown.text()).toContain('](/compare/n8n-alternatives)')
})

test.each(['', '/memory', '/packages', '/triggers', '/credentials', '/apps'])(
	'feature %s renders its content before client JavaScript',
	async (suffix) => {
		const { html } = await document(`/features${suffix}?utm_source=test`)
		expect(html).not.toContain('Loading page')
		expect(html.match(/<h1[ >]/g)).toHaveLength(1)
		expect(html.match(/<main[ >]/g)).toHaveLength(1)
		if (suffix)
			expect(html).toContain(
				`/images/lantern/kody-primitives-orb-${suffix === '/credentials' ? 'integrations' : suffix.slice(1)}.webp`,
			)
		if (suffix === '/credentials')
			contains(html, [
				'href="/onboarding"',
				'Connect your agent',
				'id="secret-result"',
				'it works with Kody.',
			])
		if (suffix === '/packages')
			contains(html, ['id="package-source-fallback"', 'src/brief.ts'])
		if (suffix === '/memory')
			contains(html, [
				'id="ms-hero-note"',
				'Lead with the decision. Keep updates short.',
			])
	},
)

test.each(['/features/secrets', '/features/integrations'])(
	'retired feature %s permanently redirects without dropping attribution',
	async (path) => {
		const server = await getSharedMcpE2eServer()
		const url = new URL(`${path}?utm_source=test`, server.origin)
		const response = await fetch(url, { redirect: 'manual' })
		expect(response.status).toBe(301)
		const location = response.headers.get('Location')
		expect(location).toBeTruthy()
		const destination = new URL(location!, server.origin)
		expect(destination.origin).toBe(server.origin)
		expect(destination.pathname).toBe('/features/credentials')
		expect(destination.search).toBe(url.search)
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
		expect(response.headers.has('Set-Cookie')).toBe(false)

		// Referral attribution deliberately makes the response uncacheable:
		// its Set-Cookie must never be shared with another visitor.
		url.searchParams.set('ref', 'shared')
		const referralResponse = await fetch(url, { redirect: 'manual' })
		expect(referralResponse.status).toBe(301)
		const referralDestination = new URL(
			referralResponse.headers.get('Location')!,
			server.origin,
		)
		expect(referralDestination.origin).toBe(server.origin)
		expect(referralDestination.pathname).toBe('/features/credentials')
		expect(referralDestination.search).toBe(url.search)
		expect(referralResponse.headers.get('Cache-Control')).toBe('no-store')
		expect(referralResponse.headers.get('Set-Cookie')).toContain(
			'kody_ref=shared;',
		)
	},
)

test('business document preserves canonical URL and business onboarding CTA', async () => {
	const { html, url } = await document('/for/business?utm_source=test')
	contains(html, [
		`href="${url.origin}/for/business"`,
		'/og/business.png',
		'href="/onboarding?business=true',
	])
	expect(html).not.toContain('Loading page')
	expect(html.match(/<h1[ >]/g)).toHaveLength(1)
	expect(html.match(/<main[ >]/g)).toHaveLength(1)
})

test('pricing initial content preserves plans, compute and factory links', async () => {
	const { html } = await document('/pricing')
	contains(html, [
		'Pro',
		'Pro + credits',
		'Worker compute per month',
		'Teams / Enterprise',
		'mailto:kody@kody.codes',
	])
	expect(html).toMatch(/<a[^>]*href="\/docs\/kody-factory"[^>]*>factory<\/a>/)
})

test('privacy initial content distinguishes model inference and data retention', async () => {
	const { html } = await document('/privacy')
	expect(html).toMatch(/<title[^>]*>Privacy<\/title>/)
	contains(html.replace(/\s+/g, ' '), [
		'does not run its own chat-model agent loop',
		'does not bill for chat tokens',
		'Cloudflare Workers AI',
		'Durable Object duration attribution: until account deletion',
	])
})

test('testimonial SSR keeps approved stories, artwork and stable anchors', async () => {
	const { html: home } = await document('/')
	expect(home.match(/class="landing-testimonial-story"/g)).toHaveLength(4)
	for (const slug of [
		'josh-tomaino',
		'jett-hays',
		'gabriel-alegria',
		'maciek-sitkowski',
	])
		expect(home).toContain(`href="/blog/early-kody-users#${slug}"`)
	contains(home, [
		'Gabriel Alegría',
		'src="/images/testimonials/gabriel-alegria.webp"',
		'href="https://www.linkedin.com/in/gabriel-alegria-mx"',
		'Erik Rasmussen',
		'src="/images/testimonials/erik-rasmussen.webp"',
		'href="https://x.com/erikras/status/2097720067316203941"',
	])
	expect(home).not.toContain('landing-testimonial-initials')
	const post = getBlogPost(landingTestimonialsStorySlug)
	expect(post?.title).toBe('Case studies')
	expect(post?.placeholder).toBe(false)
	expect(getReadNextBlogPost(landingTestimonialsStorySlug)).not.toBeNull()
	for (const path of [
		`/blog/${landingTestimonialsStorySlug}`,
		'/case-studies',
	]) {
		const { html } = await document(path)
		contains(html, [
			'id="josh-tomaino"',
			'id="jett-hays"',
			'id="gabriel-alegria"',
			'id="maciek-sitkowski"',
			'Gabriel Alegría',
			'Maciek Sitkowski',
		])
		if (path === '/case-studies')
			contains(html, [
				'Frontend Developer, Keto-Mojo',
				'/blog/early-kody-users',
			])
	}
})

test('public signup CTAs stay tied to their plan or get-started section', async () => {
	const { html: faq } = await document('/faq')
	expect(faq.match(/data-faq="get-started"[\s\S]*?<\/details>/)?.[0]).toContain(
		'href="/signup"',
	)
	const { html: pricing } = await document('/pricing')
	expect(pricing).not.toContain('id="plan-standard"')
	for (const id of ['plan-free', 'plan-pro']) {
		expect(
			pricing.match(
				new RegExp(`<section[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`),
			)?.[0],
		).toContain('href="/signup"')
	}
	const { html: home } = await document('/')
	expect(home).toContain('href="/docs/connect-your-agent"')
	const slug = listBlogPosts()[0]?.slug
	expect(slug).toBeTruthy()
	const { html: blog } = await document(`/blog/${slug}`)
	expect(
		blog.match(
			/<div[^>]*>[\s\S]*Give your assistant a home[\s\S]*?<\/div>/,
		)?.[0],
	).toContain('href="/signup"')
})

test('homepage renders ordered videos and the agent-led CTA for every session', async () => {
	const server = await getSharedMcpE2eServer()
	const videos = [
		{
			videoId: 'iGMkgjXc8Ho',
			title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
		},
		{
			videoId: 'QA0xYMAMjEg',
			title: 'Introducing Kody: Your Personal Software Factory',
		},
		{
			videoId: 'o5L5OprLhBg',
			title: 'Kody fixes a Stripe webhook after we renamed the domain',
		},
		{ videoId: 'OZKDO9Pzmo0', title: 'Shade automation from an INTENT.md' },
	]
	await server.seedHeroVideos(videos)
	const { html: home } = await document(`/?fixture=${crypto.randomUUID()}`)
	const hero =
		home.match(/<section[^>]*class="landing-hero"[\s\S]*?<\/section>/)?.[0] ??
		''
	contains(hero, [
		landingHeroPrimaryCta,
		'href="/docs/connect-your-agent"',
		'landing-agents',
	])
	expect(hero).not.toContain('landing-hero-video')
	expect(hero).not.toContain('landing-hero-agents')
	contains(home, [
		'class="landing-pcard"',
		'landing-hero-agents',
		'landing-videos',
		'role="listbox"',
		'landing-hero-agent-light',
		'landing-hero-agent-track',
		'href="/believe"',
		'href="/features/credentials"',
	])
	const thumbnails = videos
		.slice(0, 2)
		.map((video) => `/youtube-thumb/${video.videoId}`)
	contains(home, thumbnails)
	expect(home.indexOf(thumbnails[0]!)).toBeLessThan(
		home.indexOf(thumbnails[1]!),
	)
	expect(home).not.toContain('data-embed-playlist')
	expect(home).not.toContain('href="/onboarding"')
	// Main retains the decorative hero lantern, but the interactive primitives
	// section lives on /features, not the home page.
	expect(home).toMatch(/<figure class="landing-lantern" data-decorative=""/)
	expect(home).not.toContain('class="landing-primitives"')
	const user = createUniqueTestUser()
	await server.ensureUser(user)
	const cookie = await loginToApp(server.origin, user)
	const { html: signedIn } = await document('/', cookie)
	const signedHero =
		signedIn.match(
			/<section[^>]*class="landing-hero"[\s\S]*?<\/section>/,
		)?.[0] ?? ''
	contains(signedHero, [
		landingHeroPrimaryCta,
		'href="/docs/connect-your-agent"',
	])
	expect(signedHero).not.toContain('href="/onboarding"')
	expect(signedHero).not.toContain('/signup?utm_source=kody.codes')
	contains(signedIn, ['landing-videos', 'landing-hero-agents'])
})

test('homepage OG variants preserve a clean canonical and reject unknown variants', async () => {
	const { html, url } = await document('/?og=triggers&utm_source=youtube')
	contains(html, [
		`property="og:image" content="${url.origin}/og/home.png?og=triggers"`,
		`name="twitter:image" content="${url.origin}/og/home.png?og=triggers"`,
		'property="og:title" content="Invoke deterministic code from anything"',
		`rel="canonical" href="${url.origin}/"`,
	])
	expect(html).not.toContain(`og:url" content="${url.origin}/?og=`)
	const { html: unknown } = await document('/?og=nope')
	expect(unknown).toContain(
		`property="og:image" content="${url.origin}/og/home.png"`,
	)
	expect(unknown).not.toContain('/og/home.png?og=')
})

test('native home Markdown retains agent discovery headers and content', async () => {
	const server = await getSharedMcpE2eServer()
	const response = await fetch(server.origin, {
		headers: { Accept: 'text/markdown' },
	})
	expect(response.status).toBe(200)
	expect(response.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	expect(response.headers.get('link')).toContain('rel="api-catalog"')
	expect(response.headers.get('vary')).toMatch(/accept/i)
	expect(await response.text()).toMatch(/^# Kody\n/)
})

test('blog artwork retains canonical social image metadata', async () => {
	const { html, url } = await document('/blog/openclaw-2-needs-a-home')
	expect(html).toContain('src="/images/openclaw-2-needs-a-home.webp"')
	expect(html).toContain(
		`property="og:image" content="${url.origin}/blog/openclaw-2-needs-a-home/og.png"`,
	)
})
