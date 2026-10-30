import { createFileRoute } from '@tanstack/react-router'
import { ogPageImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/og_/{$page}.png')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: ogPageImageHttp } },
})
