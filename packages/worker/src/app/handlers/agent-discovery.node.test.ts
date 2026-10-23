import { expect, test } from 'vitest'
import { createOpenaiAppsChallengeHandler } from './agent-discovery.ts'

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
