import { createFileRoute } from '@tanstack/react-router'
import { docsConnectMarkdownHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/docs_/connect.md')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: docsConnectMarkdownHttp } },
})
