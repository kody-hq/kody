import { createFileRoute } from '@tanstack/react-router'
import { authProviderCallbackHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/auth_/$provider_/callback')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: authProviderCallbackHttp } },
})
