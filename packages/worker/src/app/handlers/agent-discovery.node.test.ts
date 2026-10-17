import { expect, test } from 'vitest'
import {
	createAgentSkillMarkdownHandler,
	createAgentSkillsIndexHandler,
	createApiCatalogHandler,
	createAuthMarkdownHandler,
	createMcpServerCardHandler,
	createOpenaiAppsChallengeHandler,
	createRobotsTxtHandler,
	createSecurityTxtHandler,
	createSitemapHandler,
} from './agent-discovery.ts'

const env = { APP_BASE_URL: 'https://kody.example' } as Env

/**
 * Independently pinned OpenAI Apps portal challenge value. Do not import the
 * handler constant here — a mistyped shared export would still pass.
 */
const expectedOpenaiAppsChallengeToken =
	'cgisbN1peOFC_FcpE83Zn5gihUckKsjEVj-tItKRkxU'

type Handler = (args: {
	request: Request
	params: { skillId: string }
}) => Promise<Response>

function call(
	action: Handler,
	url: string,
	init?: RequestInit,
	params: { skillId: string } = { skillId: '' },
) {
	return action({
		request: new Request(url, init),
		params,
	})
}

test('agent discovery handlers serve robots, sitemap, cards, auth.md, and skills', async () => {
	const robots = await call(
		createRobotsTxtHandler(env),
		'https://kody.example/robots.txt',
	)
	expect(robots.status).toBe(200)
	expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8')
	expect(robots.headers.get('access-control-allow-origin')).toBe('*')
	expect(await robots.text()).toContain('User-agent: *')

	const sitemap = await call(
		createSitemapHandler(env),
		'https://kody.example/sitemap.xml',
	)
	expect(sitemap.status).toBe(200)
	expect(sitemap.headers.get('content-type')).toBe(
		'application/xml; charset=utf-8',
	)
	expect(await sitemap.text()).toContain(
		'https://kody.example/docs/how-kody-works',
	)

	const card = await call(
		createMcpServerCardHandler(env),
		'https://kody.example/.well-known/mcp/server-card.json',
	)
	expect(card.status).toBe(200)
	const cardBody = (await card.json()) as {
		url: string
		transport: { type: string }
	}
	expect(cardBody.url).toBe('https://kody.example/mcp')
	expect(cardBody.transport.type).toBe('streamable-http')

	const catalog = await call(
		createApiCatalogHandler(env),
		'https://kody.example/.well-known/api-catalog',
	)
	expect(catalog.headers.get('content-type')).toBe(
		'application/linkset+json; charset=utf-8',
	)
	const catalogBody = (await catalog.json()) as {
		linkset: Array<{ anchor: string }>
	}
	expect(catalogBody.linkset[0]?.anchor).toBe('https://kody.example/mcp')

	const authMd = await call(
		createAuthMarkdownHandler(env),
		'https://kody.example/auth.md',
	)
	expect(authMd.headers.get('content-type')).toBe(
		'text/markdown; charset=utf-8',
	)
	expect(await authMd.text()).toMatch(/^# auth\.md\n/)

	const skillsIndex = await call(
		createAgentSkillsIndexHandler(env),
		'https://kody.example/.well-known/agent-skills/index.json',
	)
	const skillsBody = (await skillsIndex.json()) as {
		skills: Array<{ name: string; url: string }>
	}
	expect(skillsBody.skills.map((skill) => skill.name)).toContain('connect-kody')

	const skillMd = await call(
		createAgentSkillMarkdownHandler(env),
		'https://kody.example/.well-known/agent-skills/connect-kody/SKILL.md',
		undefined,
		{ skillId: 'connect-kody' },
	)
	expect(skillMd.status).toBe(200)
	expect(await skillMd.text()).toMatch(/^# Connect Kody\n/)

	const missingSkill = await call(
		createAgentSkillMarkdownHandler(env),
		'https://kody.example/.well-known/agent-skills/nope/SKILL.md',
		undefined,
		{ skillId: 'nope' },
	)
	expect(missingSkill.status).toBe(404)

	const securityTxt = await call(
		createSecurityTxtHandler(env),
		'https://kody.example/.well-known/security.txt',
	)
	expect(await securityTxt.text()).toContain('mailto:me@kentcdodds.com')

	const openaiChallenge = await call(
		createOpenaiAppsChallengeHandler(env),
		'https://kody.example/.well-known/openai-apps-challenge',
	)
	expect(openaiChallenge.status).toBe(200)
	expect(openaiChallenge.headers.get('content-type')).toBe(
		'text/plain; charset=utf-8',
	)
	expect(openaiChallenge.headers.get('www-authenticate')).toBeNull()
	expect(openaiChallenge.headers.get('location')).toBeNull()
	expect(openaiChallenge.headers.get('access-control-allow-origin')).toBe('*')
	expect(await openaiChallenge.text()).toBe(expectedOpenaiAppsChallengeToken)
})

test('openai apps challenge stays unauthenticated and returns exact token bytes', async () => {
	const action = createOpenaiAppsChallengeHandler(env)

	const response = await call(
		action,
		'https://kody.example/.well-known/openai-apps-challenge',
		{ method: 'GET' },
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
	expect(response.headers.get('www-authenticate')).toBeNull()
	expect(response.headers.get('location')).toBeNull()
	const body = await response.text()
	expect(body).toBe(expectedOpenaiAppsChallengeToken)
	expect(body).not.toMatch(/\s$/)
	expect(body.length).toBe(43)
})
