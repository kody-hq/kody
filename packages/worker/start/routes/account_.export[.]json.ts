import { createFileRoute } from '@tanstack/react-router'
import { accountExportHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/account_/export.json')({
	server: { handlers: { GET: accountExportHttp } },
})
