import { createFileRoute } from '@tanstack/react-router'
import { ogPageImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/og_/{$page}.png')({
	server: { handlers: { GET: ogPageImageHttp } },
})
