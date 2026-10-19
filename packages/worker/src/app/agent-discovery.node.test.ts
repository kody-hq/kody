import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { listBlogPosts } from '#worker/blog/catalog.ts'
import { listGuides } from '#worker/guides/catalog.ts'
import {
	agentSkillMarkdownPath,
	agentSkills,
	buildAgentSkillsIndex,
	buildApiCatalog,
	buildAuthMarkdown,
	buildHomeMarkdown,
	buildHomeSoftwareApplicationJsonLd,
	buildNotFoundMarkdown,
	buildOpenApiDiscoveryMarkdown,
	buildMcpServerCard,
	buildRobotsTxt,
	buildSecurityTxt,
	buildSitemapXml,
	formatLinkHeader,
	getAgentSkill,
	homeSoftwareApplicationJsonLdCspHash,
	homeSoftwareApplicationJsonLdScriptText,
	listAgentDiscoveryLinks,
	listPublicSitemapEntries,
	mcpResourcePath,
	sha256Hex,
	withAgentDiscoveryLinkHeaders,
} from './agent-discovery.ts'

const origin = 'https://kody.example'

test('agent discovery documents describe the MCP server and public pages', async () => {
	const robots = buildRobotsTxt(origin)
	expect(robots).toContain('User-agent: *')
	expect(robots).toContain('User-agent: GPTBot')
	expect(robots).toContain('User-agent: ClaudeBot')
	expect(robots).toContain(
		'Content-Signal: search=yes, ai-input=yes, ai-train=no',
	)
	expect(robots).toContain('Disallow: /account')
	expect(robots).toContain('Disallow: /auth/')
	expect(robots).toContain('Disallow: /connect/secrets')
	expect(robots).toContain('Disallow: /connect/secret-set')
	expect(robots).not.toContain('Disallow: /auth.md')
	expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`)

	const sitemap = buildSitemapXml(origin)
	for (const suffix of [
		'',
		'/memory',
		'/packages',
		'/triggers',
		'/credentials',
		'/apps',
	]) {
		expect(sitemap).toContain(`<loc>${origin}/features${suffix}</loc>`)
	}
	expect(sitemap).not.toContain(`<loc>${origin}/features/secrets</loc>`)
	expect(sitemap).not.toContain(`<loc>${origin}/features/integrations</loc>`)

	expect(sitemap).toContain(
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
	)
	expect(sitemap).toContain(`<loc>${origin}/</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/discord</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/faq</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/case-studies</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/believe</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/support</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/docs</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/docs/connect</loc>`)
	expect(sitemap).toContain(`<loc>${origin}/auth.md</loc>`)
	for (const guide of listGuides()) {
		if (guide.slug === 'what-is-kody') continue
		expect(sitemap).toContain(`<loc>${origin}/docs/${guide.slug}</loc>`)
	}
	// The introduction is canonical at /docs, so its slug URL stays out.
	expect(sitemap).not.toContain(`<loc>${origin}/docs/what-is-kody</loc>`)
	expect(sitemap).not.toContain(`<loc>${origin}/docs/admin-events</loc>`)
	for (const post of listBlogPosts()) {
		expect(sitemap).toContain(`<loc>${origin}/blog/${post.slug}</loc>`)
		expect(sitemap).toContain(`<lastmod>${post.date}</lastmod>`)
	}
	expect(
		listPublicSitemapEntries().some((entry) => entry.path === '/account'),
	).toBe(false)

	const card = buildMcpServerCard(origin)
	expect(card.serverInfo).toEqual({
		name: 'kody-mcp',
		title: 'Kody',
		version: '1.0.0',
	})
	expect(card.description).toContain('individuals and teams')
	expect(card.url).toBe(`${origin}${mcpResourcePath}`)
	expect(card.transport).toEqual({
		type: 'streamable-http',
		endpoint: `${origin}${mcpResourcePath}`,
	})
	expect(card.capabilities.tools).toBe(true)

	const catalog = buildApiCatalog(origin)
	expect(catalog.linkset[0]?.anchor).toBe(`${origin}${mcpResourcePath}`)
	expect(catalog.linkset[0]?.['service-desc']?.[0]?.href).toBe(
		`${origin}/.well-known/mcp/server-card.json`,
	)
	const openApiEntry = catalog.linkset.find(
		(entry) => entry.anchor === 'https://api.kody.codes/v1',
	)
	expect(openApiEntry?.['service-desc']?.[0]).toEqual({
		href: 'https://api.kody.codes/openapi.json',
		type: 'application/json',
	})
	expect(openApiEntry?.['service-doc']?.[0]).toEqual({
		href: 'https://api-docs.kody.codes/',
		type: 'text/html',
	})
	expect(openApiEntry?.['service-doc']?.[1]).toEqual({
		href: `${origin}/docs/open-api.md`,
		type: 'text/markdown',
	})

	const notFoundMd = buildNotFoundMarkdown(origin)
	expect(notFoundMd.length).toBeGreaterThan(20)
	expect(notFoundMd).toContain('# Not found')
	expect(notFoundMd).toContain(`${origin}/docs`)
	expect(notFoundMd).toContain(`${origin}/sitemap.xml`)
	expect(notFoundMd).toContain(`${origin}/llms.txt`)

	const openApiMd = buildOpenApiDiscoveryMarkdown(origin)
	expect(openApiMd).toContain('## Kody Open API')
	expect(openApiMd).toContain('https://api.kody.codes/openapi.json')
	expect(openApiMd).toContain('https://api-docs.kody.codes/')
	expect(openApiMd).toContain(`${origin}/docs/open-api.md`)
	expect(openApiMd).toContain(`${origin}/docs/api-versioning.md`)

	const jsonLd = buildHomeSoftwareApplicationJsonLd()
	expect(jsonLd).toMatchObject({
		'@type': 'SoftwareApplication',
		name: 'Kody',
		url: 'https://kody.codes',
		offers: { name: 'Free', price: '0', priceCurrency: 'USD' },
		sameAs: ['https://github.com/kody-hq/kody'],
	})
	expect(jsonLd.description.length).toBeGreaterThan(20)
	const jsonLdText = homeSoftwareApplicationJsonLdScriptText()
	expect(homeSoftwareApplicationJsonLdCspHash).toBe(
		`'sha256-${createHash('sha256').update(jsonLdText, 'utf8').digest('base64')}'`,
	)

	const authMd = buildAuthMarkdown(origin)
	expect(authMd.startsWith('# auth.md\n')).toBe(true)
	expect(authMd).toContain('"skill": "connect-kody"')
	expect(authMd).toContain(`"register_uri": "${origin}/oauth/register"`)
	expect(authMd).toContain(`${origin}${mcpResourcePath}`)
	expect(authMd).toContain('individuals and teams')
	expect(authMd).toContain('credentials')

	const homeMd = buildHomeMarkdown(origin)
	expect(homeMd.startsWith('# Kody\n')).toBe(true)
	expect(homeMd).toContain(`${origin}${mcpResourcePath}`)
	expect(homeMd).toContain(`${origin}/docs/what-is-kody.md`)
	expect(homeMd).toContain(`${origin}/llms.txt`)
	expect(homeMd).toContain('individuals and teams')
	expect(homeMd).toContain('orgs, teams,')

	expect(getAgentSkill('connect-kody')?.body).toContain('individuals and')
	expect(getAgentSkill('what-is-kody')?.body).toContain('orgs, teams, grants')

	const now = new Date('2026-08-18T20:00:00.000Z')
	const securityTxt = buildSecurityTxt(origin, now)
	expect(securityTxt).toContain('Contact: mailto:me@kentcdodds.com')
	expect(securityTxt).toContain(
		'Contact: https://github.com/kody-hq/kody/security/advisories/new',
	)
	expect(securityTxt).toContain('Expires: 2027-08-18T20:00:00.000Z')
	expect(securityTxt).toContain(`Canonical: ${origin}/.well-known/security.txt`)
	expect(securityTxt).toContain(
		'Policy: https://raw.githubusercontent.com/kody-hq/kody/main/SECURITY.md',
	)

	expect(
		getAgentSkill('connect-kody')?.body.startsWith('# Connect Kody\n'),
	).toBe(true)
	expect(getAgentSkill('missing')).toBeNull()
	const index = await buildAgentSkillsIndex(origin)
	expect(index.skills).toHaveLength(agentSkills.length)
	const connect = index.skills.find((skill) => skill.name === 'connect-kody')
	expect(connect?.url).toBe(
		`${origin}${agentSkillMarkdownPath('connect-kody')}`,
	)
	expect(connect?.digest).toBe(
		`sha256:${await sha256Hex(getAgentSkill('connect-kody')?.body ?? '')}`,
	)

	const links = listAgentDiscoveryLinks(origin)
	const header = formatLinkHeader(links)
	expect(header).toContain(
		`<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
	)
	expect(header).toContain(`rel="describedby"`)
	expect(header).toContain(`rel="service-doc"`)
	const withLinks = withAgentDiscoveryLinkHeaders(
		new Response('ok', { headers: { 'Content-Type': 'text/html' } }),
		origin,
	)
	expect(withLinks.headers.get('link')).toBe(header)
	expect(withLinks.headers.get('content-type')).toBe('text/html')
})
