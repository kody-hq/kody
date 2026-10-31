import { createFileRoute } from '@tanstack/react-router'
import { desktopSessionHttp } from '#start/server/desktop-auth'
export const Route = createFileRoute('/desktop/session')({
	staticData: { documentNavigation: true },
	server: { handlers: { POST: desktopSessionHttp } },
})
