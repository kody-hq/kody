import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
export const loadPackageSessionInsights = createServerFn({ method: 'GET' })
	.validator((input: { username: string; kodyId: string }) => {
		if (
			!input ||
			typeof input.username !== 'string' ||
			typeof input.kodyId !== 'string' ||
			!input.username ||
			!input.kodyId
		)
			throw notFound()
		return { username: input.username, kodyId: input.kodyId }
	})
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ setAuthSessionSecret },
			{ readPackageSessionInsightsData },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/env.ts'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/handlers/package-session-insights.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'no-store')
		const result = await readPackageSessionInsightsData(
			getRequest(),
			data,
			bindings,
		)
		if (result.status === 401) throw redirect({ href: '/login' })
		if (result.status === 404) throw notFound()
		return result.data
	})
