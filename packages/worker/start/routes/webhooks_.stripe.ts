import { createFileRoute } from '@tanstack/react-router'
import { stripeWebhookHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/webhooks_/stripe')({
	server: { handlers: { POST: stripeWebhookHttp } },
})
