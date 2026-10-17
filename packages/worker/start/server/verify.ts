import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

export const loadVerifyPage = createServerFn({ method: 'GET' })
	.validator((search: string) => {
		if (
			typeof search !== 'string' ||
			(search !== '' && !search.startsWith('?'))
		)
			throw new Error('Invalid search')
		return search
	})
	.handler(async ({ data: search }) => {
		const [
			{ env },
			{ getRequest },
			{ getEnv },
			{ readVerifySession, setVerifySessionSecret },
			{ normalizeRedirectTo },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/env.ts'),
			import('../../src/app/verify-session.ts'),
			import('../../universal/safe-redirect.ts'),
		])
		setVerifySessionSecret(getEnv(env).COOKIE_SECRET)
		if (!(await readVerifySession(getRequest()))) {
			const target = normalizeRedirectTo(
				new URLSearchParams(search).get('redirectTo'),
			)
			throw redirect({
				href: target
					? `/login?redirectTo=${encodeURIComponent(target)}`
					: '/login',
				statusCode: 302,
			})
		}
		return null
	})
