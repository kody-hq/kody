import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	env: {
		COOKIE_SECRET: 'request-secret',
		OAUTH_PROVIDER: { revokeGrant: vi.fn() },
	},
	limit: vi.fn(),
	secret: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	getGlobalStartContext: () => ({ env: state.env }),
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://kody.test/_serverFn/password-reset'),
	setResponseHeader: vi.fn(),
}))
vi.mock('#app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('#app/auth-session.ts', () => ({ setAuthSessionSecret: state.secret }))
vi.mock('#app/rate-limit.ts', () => ({ checkAuthRateLimit: state.limit }))
vi.mock('#worker/audit-log.ts', () => ({ getRequestIp: () => '127.0.0.1' }))
import { publicAuthContext } from './auth-mutation-context.ts'

test('password reset receives request OAuth helpers after auth rate limiting', async () => {
	state.limit.mockResolvedValue({ allowed: true })
	const context = await publicAuthContext()
	expect(context.env).toBe(state.env)
	expect(state.limit).toHaveBeenCalledWith(state.env, 'auth:ip:127.0.0.1')
	expect(state.secret).toHaveBeenCalledWith('request-secret')
})
