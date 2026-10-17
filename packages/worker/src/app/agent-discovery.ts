import {
	listPublicWebsitePages,
	listPublicBlogPages,
} from '#app/public-content.ts'
import {
	kodyMcpServerName,
	kodyMcpServerTitle,
	kodyMcpServerVersion,
} from '#mcp/kody-mcp-server-info.ts'
import { listGuides } from '#worker/guides/catalog.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import { docHref, docsIntroSlug } from '#universal/docs-nav.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'

export const mcpResourcePath = '/mcp'
export const mcpServerCardPath = '/.well-known/mcp/server-card.json'
export const apiCatalogPath = '/.well-known/api-catalog'
export const agentSkillsIndexPath = '/.well-known/agent-skills/index.json'
export const securityTxtPath = '/.well-known/security.txt'
export const openaiAppsChallengePath = '/.well-known/openai-apps-challenge'
export const authMdPath = '/auth.md'
export const robotsTxtPath = '/robots.txt'
export const sitemapPath = '/sitemap.xml'

/** Production Open API host (separate Worker from the marketing origin). */
export const kodyOpenApiOrigin = 'https://api.kody.codes'
/** Scalar interactive docs for {@link kodyOpenApiOrigin}. */
export const kodyApiDocsOrigin = 'https://api-docs.kody.codes'
export const kodyOpenApiSpecUrl = `${kodyOpenApiOrigin}/openapi.json`
export const kodyOpenApiV1Anchor = `${kodyOpenApiOrigin}/v1`
export const kodyGithubUrl = 'https://github.com/kody-hq/kody'

/**
 * Public OpenAI Apps domain-verification token for `openaiAppsChallengePath`.
 * Not a secret: the portal fetches it unauthenticated as `text/plain`.
 */
export const openaiAppsChallengeToken =
	'cgisbN1peOFC_FcpE83Zn5gihUckKsjEVj-tItKRkxU'

/** Matches the MCP server `version` advertised on both protocol lanes. */
export const kodyMcpServerCardVersion = kodyMcpServerVersion

const aiCrawlerUserAgents = [
	'GPTBot',
	'ChatGPT-User',
	'OAI-SearchBot',
	'ClaudeBot',
	'Claude-Web',
	'anthropic-ai',
	'Google-Extended',
	'Applebot-Extended',
	'PerplexityBot',
	'Amazonbot',
	'Bytespider',
	'CCBot',
	'cohere-ai',
	'meta-externalagent',
	'FacebookBot',
	'Diffbot',
	'omgilibot',
] as const

const robotsDisallowPaths = [
	'/account',
	'/admin',
	'/oauth',
	'/auth/',
	'/__maintenance',
	'/webhooks',
	'/connect/oauth',
	'/connect/secrets',
	'/connect/secret-set',
	'/connect/credential',
] as const

export type AgentSkillDefinition = {
	name: string
	description: string
	body: string
}

const connectKodySkillBody = `# Connect Kody

Kody is Your agents' cloud: an OAuth-protected MCP cloud for individuals and
teams. You use it from an existing MCP host (Cursor, ChatGPT, Claude Desktop,
Claude Code, Codex, Copilot, Grok, OpenCode, OpenClaw, Hermes Agent, Muse).
There is no separate Kody chat app.

## When to use

Use this skill when a person wants to connect their agent to Kody, or when you
land on kody.codes and need to add the MCP server.

## Connect

1. Read \`/auth.md\` on the same origin for registration and OAuth details.
2. Add this deployment's MCP URL: \`{origin}/mcp\` (production:
   \`https://kody.codes/mcp\`).
3. Complete the host's OAuth flow. The person signs in to Kody if needed, then
   approves access. Their email must be verified before authorize can finish.
4. After the connection works, call \`search\` before \`execute\`. Start with
   \`search({ query: "what can you do" })\` or fetch \`/docs.md\` for the
   introduction plus an index of every doc.

Client-specific setup lives on \`/onboarding\` and in
\`/docs/connect-your-agent.md\`. Do not ask anyone to paste credentials, tokens,
or passwords into chat.
`

const whatIsKodySkillBody = `# What is Kody

Kody is Your agents' cloud: for individuals and teams (orgs, teams, grants),
reached over MCP. Accounts hold packages, jobs, credentials, memories, email,
and storage under org isolation. The public MCP surface is two tools:
\`search\` and \`execute\`.

## When to use

Use this skill when deciding whether Kody fits, before any account or MCP
connection. Do not set anything up during discovery.

## How to run discovery

1. Fetch \`/docs/what-is-kody.md\` on the same origin (or
   \`https://kody.codes/docs/what-is-kody.md\`).
2. Interview conversationally: tools they use, chores they do by hand,
   automations they have wished for. Ask at most two short questions per
   message.
3. Finish with three to five specific opportunities, then a short "Next steps
   if you want to connect me to Kody" section pointing at \`/onboarding\` and
   \`/auth.md\`.
`

export const agentSkills: ReadonlyArray<AgentSkillDefinition> = [
	{
		name: 'connect-kody',
		description:
			'Connect an MCP host to Kody. Use when adding https://kody.codes/mcp or completing OAuth.',
		body: connectKodySkillBody,
	},
	{
		name: 'what-is-kody',
		description:
			'Decide whether Kody fits before connecting. Use for a no-account capability tour and discovery interview.',
		body: whatIsKodySkillBody,
	},
]

const agentSkillsByName = new Map(
	agentSkills.map((skill) => [skill.name, skill]),
)

export function getAgentSkill(name: string): AgentSkillDefinition | null {
	return agentSkillsByName.get(name) ?? null
}

export function agentSkillMarkdownPath(name: string) {
	return `/.well-known/agent-skills/${name}/SKILL.md`
}

export function buildRobotsTxt(origin: string): string {
	const disallow = robotsDisallowPaths.map((path) => `Disallow: ${path}`)
	const wildcardBlock = [
		'User-agent: *',
		'Content-Signal: search=yes, ai-input=yes, ai-train=no',
		'Allow: /',
		...disallow,
	]
	const aiBlock = [
		...aiCrawlerUserAgents.map((agent) => `User-agent: ${agent}`),
		'Content-Signal: search=yes, ai-input=yes, ai-train=no',
		'Allow: /',
		...disallow,
	]
	return [
		...wildcardBlock,
		'',
		...aiBlock,
		'',
		`Sitemap: ${origin}${sitemapPath}`,
		'',
	].join('\n')
}

type SitemapEntry = {
	path: string
	lastmod?: string
}

export function listPublicSitemapEntries(): ReadonlyArray<SitemapEntry> {
	// The introduction is canonical at `/docs` (already in the static list).
	const guides = listGuides()
		.filter((guide) => guide.slug !== docsIntroSlug)
		.map((guide) => ({ path: docHref(guide.slug) }))
	return [...listPublicWebsitePages(), ...guides, ...listPublicBlogPages()]
}

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

export function buildSitemapXml(origin: string): string {
	const urls = listPublicSitemapEntries()
		.map((entry) => {
			const loc = `${origin}${entry.path === '/' ? '/' : entry.path}`
			const lastmod = entry.lastmod
				? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`
				: ''
			return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmod}\n  </url>`
		})
		.join('\n')
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		urls,
		'</urlset>',
		'',
	].join('\n')
}

export function buildMcpServerCard(origin: string) {
	const endpoint = `${origin}${mcpResourcePath}`
	return {
		serverInfo: {
			// Match handshake Implementation.name / title so discovery clients
			// that compare card identity to initialize serverInfo agree.
			name: kodyMcpServerName,
			title: kodyMcpServerTitle,
			version: kodyMcpServerCardVersion,
		},
		description:
			"Your agents' cloud for individuals and teams. MCP with search and execute. OAuth required. Connect from an existing MCP host. There is no separate Kody chat app.",
		url: endpoint,
		transport: {
			type: 'streamable-http',
			endpoint,
		},
		capabilities: {
			tools: true,
			resources: false,
			prompts: false,
		},
	}
}

export function buildApiCatalog(origin: string) {
	const mcp = `${origin}${mcpResourcePath}`
	const card = `${origin}${mcpServerCardPath}`
	return {
		linkset: [
			{
				anchor: mcp,
				'service-desc': [
					{
						href: card,
						type: 'application/json',
					},
				],
				'service-doc': [
					{
						href: `${origin}${authMdPath}`,
						type: 'text/markdown',
					},
					{
						href: `${origin}/docs/what-is-kody.md`,
						type: 'text/markdown',
					},
				],
				status: [
					{
						href: `${origin}/health`,
					},
				],
			},
			{
				anchor: kodyOpenApiV1Anchor,
				'service-desc': [
					{
						href: kodyOpenApiSpecUrl,
						type: 'application/json',
					},
				],
				'service-doc': [
					{
						href: `${kodyApiDocsOrigin}/`,
						type: 'text/html',
					},
					{
						href: `${origin}/docs/open-api.md`,
						type: 'text/markdown',
					},
					{
						href: `${origin}/docs/api-versioning.md`,
						type: 'text/markdown',
					},
				],
				status: [
					{
						href: `${kodyOpenApiOrigin}/health`,
					},
				],
			},
			{
				anchor: `${origin}${oauthPaths.authorize}`,
				'service-desc': [
					{
						href: `${origin}${oauthPaths.discovery}`,
						type: 'application/json',
					},
				],
			},
		],
	}
}

export function buildAuthMarkdown(origin: string): string {
	const mcp = `${origin}${mcpResourcePath}`
	const registerUri = `${origin}${oauthPaths.register}`
	const agentAuth = {
		skill: 'connect-kody',
		register_uri: registerUri,
		methods: [
			{
				type: 'oauth2',
				grant_types: ['authorization_code', 'refresh_token'],
				authorization_endpoint: `${origin}${oauthPaths.authorize}`,
				token_endpoint: `${origin}${oauthPaths.token}`,
				registration_endpoint: registerUri,
				client_id_metadata_document_supported: true,
				scopes: [...mcpOauthScopes],
				resource: mcp,
				bearer_methods_supported: ['header'],
			},
		],
	}
	return [
		'# auth.md',
		'',
		"Kody is Your agents' cloud: an OAuth-protected MCP cloud for individuals and teams.",
		`Agents connect at \`${mcp}\` from an existing MCP host. People complete`,
		'sign-in and consent in the browser; do not ask anyone to paste credentials',
		'or tokens into chat.',
		'',
		'## Add the MCP server',
		'',
		`1. Point the host at \`${mcp}\`.`,
		'2. Complete the OAuth flow the host opens. Sign in to Kody if needed,',
		'   then approve access.',
		'3. The account email must be verified before authorize can finish. If',
		'   authorize asks to verify, keep that tab open, finish verification',
		'   from the email link or `/pending-verification`, then continue.',
		'4. After the connection works, call `search` before `execute`.',
		'',
		'Client-specific setup (Cursor, ChatGPT, Claude Desktop, Claude Code,',
		'Codex, Copilot, Grok, OpenCode, OpenClaw, Hermes Agent, Muse) lives on',
		`\`/onboarding\`. A no-account capability tour is at \`${origin}/docs/what-is-kody.md\`;`,
		`the full docs index is \`${origin}/llms.txt\`.`,
		'',
		'## OAuth',
		'',
		`- Authorization server: \`${origin}${oauthPaths.discovery}\``,
		`- Protected resource: \`${origin}/.well-known/oauth-protected-resource/mcp\``,
		`- Resource: \`${mcp}\``,
		`- Scopes: \`${mcpOauthScopes.join('`, `')}\``,
		`- Dynamic client registration: \`${registerUri}\``,
		'- Client ID Metadata Documents (CIMD) are supported.',
		'',
		'## agent_auth',
		'',
		'```json',
		JSON.stringify(agentAuth, null, 2),
		'```',
		'',
	].join('\n')
}

export function buildHomeMarkdown(origin: string): string {
	return [
		'# Kody',
		'',
		"Kody is Your agents' cloud: for individuals and teams (orgs, teams,",
		'and grants). You use it from Cursor, ChatGPT, Claude, Codex, Copilot,',
		'Grok, or any MCP host, not from a separate Kody chat app.',
		'',
		`MCP URL: \`${origin}${mcpResourcePath}\` (OAuth required).`,
		'',
		'## Start here',
		'',
		`- [What is Kody?](${origin}/docs/what-is-kody.md) — capability tour, no account`,
		`- [How to connect](${origin}${authMdPath}) — OAuth and host setup`,
		`- [Docs](${origin}/docs.md) — introduction plus the full index (compact: ${origin}/llms.txt)`,
		`- [Connect a provider](${origin}/docs/connect.md) — Discord, GitHub, Google, and more`,
		`- [Get started](${origin}/onboarding)`,
		`- [Pricing](${origin}/pricing)`,
		`- [FAQ](${origin}/faq)`,
		`- [Public packages](${origin}/community)`,
		'',
		'## Machine-readable discovery',
		'',
		`- MCP server card: ${origin}${mcpServerCardPath}`,
		`- API catalog: ${origin}${apiCatalogPath}`,
		`- Agent skills: ${origin}${agentSkillsIndexPath}`,
		`- Sitemap: ${origin}${sitemapPath}`,
		'',
		'The MCP surface is two tools: `search` and `execute`. After connecting,',
		'search first.',
		'',
	].join('\n')
}

/**
 * Markdown body for generic HTTP 404s when the client prefers
 * `Accept: text/markdown`. Status stays 404; HTML remains the default.
 */
export function buildNotFoundMarkdown(origin: string): string {
	return [
		'# Not found',
		'',
		'That URL is not on this Kody site (HTTP 404).',
		'',
		'Useful next steps:',
		'',
		`- [Kody docs](${origin}/docs)`,
		`- [About Kody](${origin}/about)`,
		`- [Contact Kody](${origin}/contact)`,
		`- [Sitemap](${origin}${sitemapPath})`,
		`- [llms.txt](${origin}/llms.txt)`,
		'',
	].join('\n')
}

export {
	buildHomeSoftwareApplicationJsonLd,
	homeSoftwareApplicationJsonLdScriptText,
	kodyCanonicalMarketingOrigin,
} from '#universal/home-json-ld.ts'

/**
 * CSP `script-src` hash for {@link homeSoftwareApplicationJsonLdScriptText}
 * at {@link kodyCanonicalMarketingOrigin}. Recompute if that JSON changes.
 */
export const homeSoftwareApplicationJsonLdCspHash =
	"'sha256-M+uP/HENbGxRZOWd2/4MlETEUXL/WxQUaUi79Pg3bMw='"

/**
 * Shared Open API discovery links for `/docs.md` and `/llms.txt`.
 * The REST surface lives on fixed production hosts, not the request origin.
 */
export function buildOpenApiDiscoveryMarkdown(baseUrl: string): string {
	return [
		'## Kody Open API',
		'',
		'Call Kody over HTTPS (OpenAPI 3.1). Available to every signed-in account.',
		'',
		`- [Interactive docs](${kodyApiDocsOrigin}/) — Scalar UI at api-docs.kody.codes`,
		`- [OpenAPI description](${kodyOpenApiSpecUrl}) — machine-readable service description`,
		`- [Kody Open API guide](${baseUrl}/docs/open-api.md) — how to mint tokens and call \`/v1\``,
		`- [API versioning and deprecation](${baseUrl}/docs/api-versioning.md) — additive \`/v1\`, phased migrations`,
		'',
	].join('\n')
}

export function buildSecurityTxt(origin: string, now = new Date()): string {
	const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
	return [
		`Contact: mailto:me@kentcdodds.com`,
		`Contact: https://github.com/kody-hq/kody/security/advisories/new`,
		`Expires: ${expires.toISOString()}`,
		'Preferred-Languages: en',
		`Canonical: ${origin}${securityTxtPath}`,
		'Policy: https://raw.githubusercontent.com/kody-hq/kody/main/SECURITY.md',
		'',
	].join('\n')
}

export async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export async function buildAgentSkillsIndex(origin: string) {
	const skills = await Promise.all(
		agentSkills.map(async (skill) => ({
			name: skill.name,
			type: 'skill-md',
			description: skill.description,
			url: `${origin}${agentSkillMarkdownPath(skill.name)}`,
			digest: `sha256:${await sha256Hex(skill.body)}`,
		})),
	)
	return {
		$schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
		skills,
	}
}

export type AgentDiscoveryLink = {
	href: string
	rel: string
	type?: string
}

export function listAgentDiscoveryLinks(
	origin: string,
): ReadonlyArray<AgentDiscoveryLink> {
	return [
		{
			href: `${origin}${apiCatalogPath}`,
			rel: 'api-catalog',
			type: 'application/linkset+json',
		},
		{
			href: `${origin}${mcpServerCardPath}`,
			rel: 'describedby',
			type: 'application/json',
		},
		{
			href: `${origin}${authMdPath}`,
			rel: 'service-doc',
			type: 'text/markdown',
		},
		{
			href: `${origin}${sitemapPath}`,
			rel: 'sitemap',
			type: 'application/xml',
		},
		{
			href: `${origin}/.well-known/oauth-protected-resource/mcp`,
			rel: 'oauth-protected-resource',
			type: 'application/json',
		},
	]
}

export function formatLinkHeader(
	links: ReadonlyArray<AgentDiscoveryLink>,
): string {
	return links
		.map((link) => {
			const type = link.type ? `; type="${link.type}"` : ''
			return `<${link.href}>; rel="${link.rel}"${type}`
		})
		.join(', ')
}

export function withAgentDiscoveryLinkHeaders(
	response: Response,
	origin: string,
): Response {
	const headers = new Headers(response.headers)
	headers.append('Link', formatLinkHeader(listAgentDiscoveryLinks(origin)))
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export function discoveryDocumentHeaders(contentType: string): Headers {
	return new Headers({
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'public, max-age=300',
		'Content-Type': contentType,
	})
}
