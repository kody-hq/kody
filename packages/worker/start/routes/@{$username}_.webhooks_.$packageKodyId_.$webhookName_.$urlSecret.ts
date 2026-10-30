import { createFileRoute } from '@tanstack/react-router'
import { webhookIngressHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/@{$username}_/webhooks_/$packageKodyId_/$webhookName_/$urlSecret',
)({
	staticData: { documentNavigation: true },
	server: { handlers: { POST: webhookIngressHttp } },
})
