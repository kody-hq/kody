import { createFileRoute } from '@tanstack/react-router'
import { authHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/auth')({
	staticData: { documentNavigation: true },
	server: { handlers: { POST: authHttp } },
})
