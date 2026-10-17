import { createFileRoute } from '@tanstack/react-router'
import { guidesRedirect } from '#start/server/legacy-redirects'
export const Route = createFileRoute('/guides.json')({
	server: { handlers: { GET: guidesRedirect } },
})
