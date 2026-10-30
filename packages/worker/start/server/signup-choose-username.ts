import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

export const loadSignupChooseUsernamePage = createServerFn({
	method: 'GET',
})
	.validator((input: { redirectTo?: string | null } | undefined) => {
		if (
			input != null &&
			(typeof input !== 'object' ||
				(input.redirectTo != null && typeof input.redirectTo !== 'string'))
		)
			throw new Error('Invalid auth return destination')
		return { redirectTo: input?.redirectTo ?? null }
	})
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ setAuthSessionSecret },
			{ setOauthPendingSignupSecret },
			{ loadOauthPendingSignupPage },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/env.ts'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/oauth-pending-signup.ts'),
			import('../../src/identity/oauth-pending-signup-operations.ts'),
		])
		const appEnv = getEnv(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		setOauthPendingSignupSecret(appEnv.COOKIE_SECRET)
		const result = await loadOauthPendingSignupPage({
			env: appEnv,
			request: getRequest(),
			fallbackRedirectTo: data.redirectTo,
		})
		if (!result.ok) {
			if ('clearCookie' in result && result.clearCookie) {
				setResponseHeader('Set-Cookie', result.clearCookie)
			}
			throw redirect({
				href: result.redirectTo,
				statusCode: 302,
			})
		}
		setResponseHeader('Cache-Control', 'private, no-store')
		return {
			csrf: result.csrf,
			suggestedUsername: result.suggestedUsername,
			email: result.email,
			provider: result.provider,
			providerUsername: result.providerUsername,
			displayName: result.displayName,
			redirectTo: result.redirectTo,
		}
	})
