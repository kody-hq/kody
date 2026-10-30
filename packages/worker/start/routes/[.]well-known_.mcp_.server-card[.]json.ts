import { createFileRoute } from '@tanstack/react-router'
import { mcpServerCardHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/mcp_/server-card.json')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: mcpServerCardHttp } },
})
