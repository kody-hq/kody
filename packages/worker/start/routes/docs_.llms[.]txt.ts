import { createFileRoute } from '@tanstack/react-router'
import { docsLlmsTxtHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/docs_/llms.txt')({
	staticData: { documentNavigation: true, anonymousDocumentCache: 'marketing' },
	server: { handlers: { GET: docsLlmsTxtHttp } },
})
