import { type OauthProviderId } from '#app/oauth-providers.ts'
import { parseLegacyHosts } from '#worker/app-legacy-redirect.ts'
export function getCallbackRedirectUri(
	env: Env,
	url: URL,
	provider: OauthProviderId,
) {
	// The OAuth login state lives in a host-scoped cookie, so the provider must
	// call back to the host that started the flow whenever that host has a
	// registered callback: the canonical APP_BASE_URL host or a dual-served
	// legacy host (APP_LEGACY_HOSTS, both registered with providers during a
	// domain migration). Other hosts (the workers.dev backup trigger) keep
	// using the configured canonical callback as before.
	const base = (() => {
		if (!env.APP_BASE_URL) return url
		let canonical: URL
		try {
			canonical = new URL(env.APP_BASE_URL)
		} catch {
			return url
		}
		const requestHost = url.hostname.toLowerCase()
		if (
			requestHost === canonical.hostname.toLowerCase() ||
			parseLegacyHosts(env.APP_LEGACY_HOSTS).includes(requestHost)
		) {
			return url
		}
		return canonical
	})()
	return new URL(`/auth/${provider}/callback`, base).toString()
}
