import { createFileRoute } from '@tanstack/react-router'
import { integrationLogoHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/integrations_/logos_/$integrationSlug')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: integrationLogoHttp } },
})
