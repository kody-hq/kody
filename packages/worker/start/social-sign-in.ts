import { useServerFn } from '@tanstack/react-start'
import { useCallback } from 'react'
import {
	readWebsiteAuthProviders,
	startWebsiteOAuth,
} from '#start/server/auth-mutations'
import {
	appendAttributionQueryParams,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'
import {
	emptyPublicFormProtection,
	type PublicFormProtectionFields,
} from '#universal/public-form-protection.ts'

type AuthProviderInfo = { id: string; label: string }
export type PublicAuthConfig = {
	providers: Array<AuthProviderInfo>
	turnstileSiteKey: string | null
}

function buildProviderStartPath(
	providerId: string,
	redirectTo: string | null,
	attribution: FirstTouchAttribution | null = null,
) {
	const params = new URLSearchParams()
	if (redirectTo) params.set('redirectTo', redirectTo)
	appendAttributionQueryParams(params, attribution)
	const query = params.toString()
	return query ? `/auth/${providerId}?${query}` : `/auth/${providerId}`
}

export function usePublicAuthConfig() {
	const send = useServerFn(readWebsiteAuthProviders)
	return useCallback(
		async function fetchPublicAuthConfig(
			signal?: AbortSignal,
		): Promise<PublicAuthConfig | null> {
			try {
				const payload = await send({ signal })
				if (!payload) return null
				const providers = (
					Array.isArray(payload.providers) ? payload.providers : []
				).filter(
					(provider: unknown): provider is AuthProviderInfo =>
						typeof provider === 'object' &&
						provider !== null &&
						typeof (provider as AuthProviderInfo).id === 'string' &&
						typeof (provider as AuthProviderInfo).label === 'string',
				)
				const turnstileSiteKey =
					typeof payload.turnstileSiteKey === 'string'
						? payload.turnstileSiteKey
						: null
				return { providers, turnstileSiteKey }
			} catch {
				return null
			}
		},
		[send],
	)
}

/**
 * Start a social sign-in or account connection: fetch the authorize URL from
 * the start endpoint and navigate to it at the top level. The CSP locks
 * `form-action` and `connect-src` to 'self', so neither a form-POST redirect
 * nor a fetch-followed redirect may leave the origin — a top-level JS
 * navigation may. Returns an error message, or null when navigation started.
 *
 * Pass `attribution` so first-touch UTMs survive the OAuth round-trip in
 * the signed login-state cookie.
 */
export function useSocialSignIn() {
	const send = useServerFn(startWebsiteOAuth)
	return useCallback(
		async function startSocialSignIn(
			providerId: string,
			redirectTo: string | null,
			protection: PublicFormProtectionFields = emptyPublicFormProtection(),
			attribution: FirstTouchAttribution | null = null,
			signal?: AbortSignal,
		): Promise<string | null> {
			const payload = await send({
				data: {
					provider: providerId,
					search: new URL(
						buildProviderStartPath(providerId, redirectTo, attribution),
						'http://localhost',
					).search,
					body: { ...protection },
				},
				signal,
			})
			if (!payload) return null
			if (
				!payload.successful ||
				payload?.ok !== true ||
				typeof payload.authorizeUrl !== 'string'
			) {
				return typeof payload?.error === 'string'
					? payload.error
					: 'Unable to start sign-in. Please try again.'
			}
			signal?.throwIfAborted()
			window.location.assign(payload.authorizeUrl)
			return null
		},
		[send],
	)
}
