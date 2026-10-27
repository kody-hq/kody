import { expect, test } from 'vitest'
import { landingTestimonialsStorySlug } from '#universal/landing-testimonials.ts'
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

test.each(['', '/memory', '/packages', '/triggers', '/credentials', '/apps'])(
	'feature %s renders its content before client JavaScript',
	async (suffix) => {
		const { html } = await document(`/features${suffix}?utm_source=test`)
		expect(html.match(/<h1[ >]/g)).toHaveLength(1)
		expect(html.match(/<main[ >]/g)).toHaveLength(1)
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

test('homepage OG variants preserve a clean canonical and reject unknown variants', async () => {
	const { html, url } = await document('/?og=triggers&utm_source=youtube')
	contains(html, [
		`property="og:image" content="${url.origin}/og/home.png?og=triggers&amp;v=2"`,
		`name="twitter:image" content="${url.origin}/og/home.png?og=triggers&amp;v=2"`,
		'property="og:title" content="Invoke deterministic code from anything"',
		`rel="canonical" href="${url.origin}/"`,
	])
	expect(html).not.toContain(`og:url" content="${url.origin}/?og=`)
	const { html: unknown } = await document('/?og=nope')
	expect(unknown).toContain(
		`property="og:image" content="${url.origin}/og/home.png?v=2"`,
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

test('homepage testimonial story links land on anchors in the case-study post', async () => {
	const { html: home } = await document('/')
	const anchors = [
		...home.matchAll(
			new RegExp(`href="/blog/${landingTestimonialsStorySlug}#([^"]+)"`, 'g'),
		),
	].map((match) => match[1])
	expect(anchors.length).toBeGreaterThan(0)
	const { html: story } = await document(
		`/blog/${landingTestimonialsStorySlug}`,
	)
	for (const anchor of anchors) expect(story).toContain(`id="${anchor}"`)
})
