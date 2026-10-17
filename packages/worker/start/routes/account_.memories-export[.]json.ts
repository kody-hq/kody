import { createFileRoute } from '@tanstack/react-router'
import { accountMemoriesExportHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/account_/memories-export.json')({
	server: { handlers: { GET: accountMemoriesExportHttp } },
})
