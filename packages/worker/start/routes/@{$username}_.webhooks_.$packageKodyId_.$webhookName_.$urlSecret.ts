import { createFileRoute } from '@tanstack/react-router'
import { webhookIngressHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/@{$username}_/webhooks_/$packageKodyId_/$webhookName_/$urlSecret',
)({ server: { handlers: { POST: webhookIngressHttp } } })
