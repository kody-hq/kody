import { createFileRoute } from '@tanstack/react-router'
import { securityTxtHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/security.txt')({
	server: { handlers: { GET: securityTxtHttp } },
})
