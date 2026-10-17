import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadFittedPlatformOauthAppLogo,
	type ServedFittedLogo,
} from '#worker/integrations/platform-app-logo.ts'
import { getPlatformOauthAppBySlug } from '#worker/integrations/platform-apps.ts'
import { getOauthApp } from '#worker/integrations/service.ts'
import { loadFittedUserOauthAppLogo } from '#worker/integrations/user-oauth-app-logo.ts'

/**
 * Serving route for provider logos. Platform (operator) assets are public.
 * User-lane assets require a signed-in session and resolve the caller's app
 * after a platform miss so `/integrations/logos/:slug` stays one URL.
 */
export function createIntegrationLogoHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { integrationSlug: string }
	}) => {
		// Disabled apps keep serving their logo: existing connections still
		// render on account pages after an operator disables new connects.
		const platformApp = await getPlatformOauthAppBySlug({
			db: env.APP_DB,
			slug: params.integrationSlug,
			includeDisabled: true,
		})
		if (platformApp?.logoKey) {
			const logo = await loadFittedPlatformOauthAppLogo({
				db: env.APP_DB,
				env,
				app: platformApp,
			})
			if (logo) return logoResponse(logo)
		}

		const user = await readAuthenticatedAppUser(request, env)
		if (!user) {
			return new Response('Not found', { status: 404 })
		}
		const app = await getOauthApp({
			env,
			userId: user.mcpUser.userId,
			slug: params.integrationSlug,
		})
		if (!app?.logoKey) {
			return new Response('Not found', { status: 404 })
		}
		const logo = await loadFittedUserOauthAppLogo({
			db: env.APP_DB,
			env,
			userId: user.mcpUser.userId,
			app,
		})
		if (!logo) {
			return new Response('Not found', { status: 404 })
		}
		return logoResponse(logo)
	}
}

function logoResponse(logo: ServedFittedLogo) {
	return new Response(logo.body, {
		headers: {
			'Cache-Control': logo.cacheControl,
			'Content-Length': String(logo.size),
			'Content-Type': logo.contentType,
			ETag: logo.httpEtag,
			'X-Content-Type-Options': 'nosniff',
		},
	})
}
