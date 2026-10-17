import { createFileRoute } from '@tanstack/react-router'
import { guidesRedirect } from '#start/server/legacy-redirects'
export const Route = createFileRoute('/guides.md')({
	server: { handlers: { GET: guidesRedirect } },
})
