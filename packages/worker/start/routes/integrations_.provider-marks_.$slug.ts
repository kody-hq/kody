import { createFileRoute } from '@tanstack/react-router'
import { providerMarkLogoHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/integrations_/provider-marks_/$slug')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: providerMarkLogoHttp } },
})
