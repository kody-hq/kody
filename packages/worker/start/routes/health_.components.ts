import { createFileRoute } from '@tanstack/react-router'
import { healthComponentsHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/health_/components')({
	server: { handlers: { GET: healthComponentsHttp } },
})
