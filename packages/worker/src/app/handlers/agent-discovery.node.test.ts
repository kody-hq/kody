import { expect, test } from 'vitest'
import {
	agentSkills,
	buildAgentSkillsIndex,
	buildAuthMarkdown,
	getAgentSkill,
	sha256Hex,
} from '#app/agent-discovery.ts'
import {
	createAgentSkillMarkdownHandler,
	createAgentSkillsIndexHandler,
	createOpenaiAppsChallengeHandler,
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
	const body = await response.text()
	expect(body).toBe(expectedOpenaiAppsChallengeToken)
})

test('agent-skills index includes kody-cli with a matching body digest', async () => {
	const index = await buildAgentSkillsIndex('https://kody.example')
	const names = index.skills.map((skill) => skill.name)
	expect(names).toEqual(
		expect.arrayContaining(['connect-kody', 'what-is-kody', 'kody-cli']),
	)
	const cli = index.skills.find((skill) => skill.name === 'kody-cli')
	expect(cli).toMatchObject({
		type: 'skill-md',
		url: 'https://kody.example/.well-known/agent-skills/kody-cli/SKILL.md',
	})
	const skill = getAgentSkill('kody-cli')
	expect(skill).not.toBeNull()
	expect(cli?.digest).toBe(`sha256:${await sha256Hex(skill!.body)}`)
	expect(skill!.body).toMatch(/execute --local/)
	expect(skill!.body).toMatch(/cliCredentialBootstrap/)
	expect(agentSkills.some((entry) => entry.name === 'kody-cli')).toBe(true)

	const indexHandler = createAgentSkillsIndexHandler(env)
	const indexResponse = await call(
		indexHandler,
		'https://kody.example/.well-known/agent-skills/index.json',
	)
	expect(indexResponse.status).toBe(200)
	const payload = (await indexResponse.json()) as typeof index
	expect(payload.skills.map((skill) => skill.name)).toEqual(
		expect.arrayContaining(['kody-cli']),
	)

	const markdownHandler = createAgentSkillMarkdownHandler(env)
	const markdownResponse = await call(
		markdownHandler,
		'https://kody.example/.well-known/agent-skills/kody-cli/SKILL.md',
		undefined,
		{ skillId: 'kody-cli' },
	)
	expect(markdownResponse.status).toBe(200)
	expect(await markdownResponse.text()).toBe(skill!.body)

	const missing = await call(
		markdownHandler,
		'https://kody.example/.well-known/agent-skills/missing/SKILL.md',
		undefined,
		{ skillId: 'missing' },
	)
	expect(missing.status).toBe(404)
})

test('auth.md does not advertise an auth.md agent_auth registration block', () => {
	const markdown = buildAuthMarkdown('https://kody.example')
	expect(markdown).toContain('https://kody.example/mcp')
	expect(markdown).toContain(
		'https://kody.example/.well-known/oauth-authorization-server',
	)
	expect(markdown).not.toContain('agent_auth')
	expect(markdown).not.toContain('register_uri')
})
