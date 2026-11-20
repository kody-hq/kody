import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { usePublicAuthConfig } from '../social-sign-in.ts'
import { renderTurnstileWidgets } from '#client/public-form-protection.ts'

export function usePublicAuthProtection() {
	const fetchPublicAuthConfig = usePublicAuthConfig()
	const config = useQuery({
		queryKey: ['public-auth-config'],
		queryFn: ({ signal }) => fetchPublicAuthConfig(signal),
		retry: false,
	})
	return config.data?.turnstileSiteKey ?? null
}

/** Ref for the Turnstile container: renders the widget when it mounts. */
export function useTurnstileRef(siteKey: string | null) {
	return useCallback(
		(node: HTMLElement | null) => {
			if (node && siteKey) void renderTurnstileWidgets(siteKey)
		},
		[siteKey],
	)
}
