import { createFileRoute } from '@tanstack/react-router'
import { appleAppSiteAssociationHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/.well-known_/apple-app-site-association',
)({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: appleAppSiteAssociationHttp } },
})
