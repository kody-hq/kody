import { createFileRoute } from '@tanstack/react-router'
import { sentryTunnelHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/sentry-tunnel')({
	staticData: { documentNavigation: true },
	server: { handlers: { POST: sentryTunnelHttp } },
})
