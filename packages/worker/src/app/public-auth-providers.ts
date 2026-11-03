import {
	getEnabledOauthProviders,
	oauthProviderDefinitions,
	type OauthProviderEnv,
} from '#app/oauth-providers.ts'
import { getTurnstileSiteKey } from '#app/public-form-protection.ts'
import type { AuthProvidersLoaderData } from '#universal/loader-data.ts'

type PublicAuthProvidersEnv = OauthProviderEnv &
	Pick<Env, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>

/**
 * Deployment config for social sign-in buttons. `/login`, `/signup`, and
 * `/oauth/authorize` embed this on full-document SSR. `/auth/providers.json`
 * returns the same object for SPA navigations.
 */
export function publicAuthProvidersLoaderData(
	env: PublicAuthProvidersEnv,
): AuthProvidersLoaderData {
	return {
		ok: true,
		turnstileSiteKey: getTurnstileSiteKey(env),
		providers: getEnabledOauthProviders(env).map((provider) => ({
			id: provider,
			label: oauthProviderDefinitions[provider].label,
		})),
	}
}
