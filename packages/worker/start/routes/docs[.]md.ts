import { createFileRoute } from '@tanstack/react-router'
import { docsMarkdownHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/docs.md')({
	server: { handlers: { GET: docsMarkdownHttp } },
})
