import { createFileRoute } from '@tanstack/react-router'
import { desktopDownloadHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/download')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: desktopDownloadHttp } },
})
