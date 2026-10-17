import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'

export const loadPendingVerification = createServerFn({ method: 'GET' })
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
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ requireAuthenticatedPageUser },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/env.ts'),
			import('../../src/app/page-auth.ts'),
		])
		const user = await requireAuthenticatedPageUser(getRequest(), getEnv(env), {
			redirectTo: `/pending-verification${search}`,
		})
		if (user instanceof Response) {
			const cookie = user.headers.get('Set-Cookie')
			if (cookie) setResponseHeader('Set-Cookie', cookie)
			throw redirect({
				href: user.headers.get('Location') ?? '/login',
				statusCode: user.status,
			})
		}
		if (user.emailVerified)
			throw redirect({
				href:
					normalizeRedirectTo(new URLSearchParams(search).get('redirectTo')) ??
					'/onboarding',
				statusCode: 302,
			})
		return {
			ok: true as const,
			email: user.email,
			emailVerificationDelivery: user.emailVerificationDelivery ?? null,
		}
	})
