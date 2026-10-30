import { createFileRoute } from '@tanstack/react-router'
import { securityTxtHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/security.txt')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: securityTxtHttp } },
})
