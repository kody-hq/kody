import { createFileRoute } from '@tanstack/react-router'
import { sessionHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/session')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: sessionHttp } },
})
