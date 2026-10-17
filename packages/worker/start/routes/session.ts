import { createFileRoute } from '@tanstack/react-router'
import { sessionHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/session')({
	server: { handlers: { GET: sessionHttp } },
})
