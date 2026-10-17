import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

export const loadAuthPage = createServerFn({ method: 'GET' })
	.validator((input: { redirectTo?: string | null }) => {
		if (
			!input ||
			typeof input !== 'object' ||
			(input.redirectTo != null && typeof input.redirectTo !== 'string')
		)
			throw new Error('Invalid auth return destination')
		return { redirectTo: input.redirectTo ?? null }
	})
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ loadSessionInfo },
			{ normalizeRedirectTo },
			{ getEnabledOauthProviders, oauthProviderDefinitions },
			{ getTurnstileSiteKey },
			{ getEnv },
			{ setAuthSessionSecret },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/session-info.ts'),
			import('../../src/app/auth-redirect.ts'),
			import('../../src/app/oauth-providers.ts'),
			import('../../src/app/public-form-protection.ts'),
			import('../../src/app/env.ts'),
			import('../../src/app/auth-session.ts'),
		])
		const appEnv = getEnv(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		const { session, setCookie } = await loadSessionInfo(getRequest(), appEnv)
		if (setCookie) setResponseHeader('Set-Cookie', setCookie)
		if (session)
			throw redirect({
				href: normalizeRedirectTo(data.redirectTo) ?? '/account',
				statusCode: 302,
			})
		return {
			authConfig: {
				ok: true as const,
				turnstileSiteKey: getTurnstileSiteKey(appEnv),
				providers: getEnabledOauthProviders(appEnv).map((provider) => ({
					id: provider,
					label: oauthProviderDefinitions[provider].label,
				})),
			},
		}
	})
