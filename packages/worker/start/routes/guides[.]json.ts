import { createFileRoute } from '@tanstack/react-router'
import { guidesRedirect } from '#start/server/legacy-redirects'
export const Route = createFileRoute('/guides.json')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: guidesRedirect } },
})
