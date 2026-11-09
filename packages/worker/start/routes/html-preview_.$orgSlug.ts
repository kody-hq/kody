import { createFileRoute } from '@tanstack/react-router'
import { htmlPreviewHttp } from '#start/server/html-preview'
export const Route = createFileRoute('/html-preview_/$orgSlug')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: htmlPreviewHttp } },
})
