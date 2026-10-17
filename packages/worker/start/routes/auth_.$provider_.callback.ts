import { createFileRoute } from '@tanstack/react-router'
import { authProviderCallbackHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/auth_/$provider_/callback')({
	server: { handlers: { GET: authProviderCallbackHttp } },
})
