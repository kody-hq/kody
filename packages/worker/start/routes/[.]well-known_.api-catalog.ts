import { createFileRoute } from '@tanstack/react-router'
import { apiCatalogHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/api-catalog')({
	server: { handlers: { GET: apiCatalogHttp } },
})
