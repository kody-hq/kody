import { createFileRoute } from '@tanstack/react-router'
import { officePreviewHttp } from '#start/server/office-preview'
export const Route = createFileRoute('/office-preview_/$orgSlug/$kind')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: officePreviewHttp } },
})
