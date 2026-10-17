import { createServerFn } from '@tanstack/react-start'
export const readWebsiteSessionInfo = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ setAuthSessionSecret },
			{ loadSessionInfo },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/session-info.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'private, no-store')
		const { session, setCookie } = await loadSessionInfo(getRequest(), bindings)
		if (setCookie) setResponseHeader('Set-Cookie', setCookie)
		return session
	},
)
