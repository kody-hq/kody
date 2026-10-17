import { createFileRoute } from '@tanstack/react-router'
import { connectionsRedirect } from '#start/server/legacy-redirects'
export const Route = createFileRoute('/@{$orgSlug}_/-/connections')({
	staticData: { orgScope: {} },
	server: { handlers: { GET: connectionsRedirect } },
})
