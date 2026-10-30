import { createFileRoute } from '@tanstack/react-router'
import { robotsTxtHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/robots.txt')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: robotsTxtHttp } },
})
