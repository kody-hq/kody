import { createFileRoute } from '@tanstack/react-router'
import { authMarkdownHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/auth.md')({
	server: { handlers: { GET: authMarkdownHttp } },
})
