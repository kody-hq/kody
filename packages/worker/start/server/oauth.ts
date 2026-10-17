import { createServerFn } from '@tanstack/react-start'
import { getStartRequestEnv } from './request-env.ts'

export const loadOAuthPage = createServerFn({ method: 'GET' })
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
			{ getRequest, setResponseHeader },
			{ loadSessionInfo },
			{ loadOAuthAuthorizeData },
			{ publicAuthProvidersLoaderData },
		] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('../../src/app/session-info.ts'),
			import('../../src/oauth-handlers.ts'),
			import('../../src/app/public-auth-providers.ts'),
		])
		const bindings = getStartRequestEnv()
		const request = getRequest()
		const url = new URL(`/oauth/authorize${search}`, request.url)
		const result = await loadOAuthAuthorizeData(request, bindings, url)
		const { session, setCookie } = await loadSessionInfo(request, bindings)
		const cookies = [...result.setCookies, setCookie].filter(
			(cookie): cookie is string => Boolean(cookie),
		)
		if (cookies.length) setResponseHeader('Set-Cookie', cookies)
		return {
			data: result.data,
			session,
			authProviders: publicAuthProvidersLoaderData(bindings),
		}
	})
