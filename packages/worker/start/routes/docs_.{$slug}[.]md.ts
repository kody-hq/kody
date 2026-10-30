import { createFileRoute } from '@tanstack/react-router'
import { docDetailMarkdownHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/docs_/{$slug}.md')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: docDetailMarkdownHttp } },
})
