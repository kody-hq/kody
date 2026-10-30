import { createFileRoute } from '@tanstack/react-router'
import { apiCatalogHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/api-catalog')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: apiCatalogHttp } },
})
