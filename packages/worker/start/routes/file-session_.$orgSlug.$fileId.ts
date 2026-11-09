import { createFileRoute } from '@tanstack/react-router'
import { fileCollaborationHttp } from '#start/server/file-collaboration-http'
export const Route = createFileRoute('/file-session_/$orgSlug/$fileId')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: fileCollaborationHttp } },
})
