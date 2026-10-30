import { createFileRoute } from '@tanstack/react-router'
import { healthHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/health')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: healthHttp } },
})
