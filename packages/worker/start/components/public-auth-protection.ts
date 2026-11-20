import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { usePublicAuthConfig } from '../social-sign-in.ts'
import { renderTurnstileWidgets } from '#client/public-form-protection.ts'

export function usePublicAuthProtection() {
	const fetchPublicAuthConfig = usePublicAuthConfig()
	const config = useQuery({
		queryKey: ['public-auth-config'],
		queryFn: ({ signal }) => fetchPublicAuthConfig(signal),
		staleTime: Infinity,
		retry: false,
	})
	const siteKey = config.data?.turnstileSiteKey ?? null
	useEffect(() => {
		if (siteKey) void renderTurnstileWidgets(siteKey)
	}, [siteKey])
	return siteKey
}
