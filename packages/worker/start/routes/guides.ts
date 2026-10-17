import { createFileRoute } from '@tanstack/react-router'
import { guidesRedirect } from '#start/server/legacy-redirects'
export const Route = createFileRoute('/guides')({
	server: { handlers: { GET: guidesRedirect } },
})
