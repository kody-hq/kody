import { createFileRoute } from '@tanstack/react-router'
import { docDetailOgImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/docs_/$slug_/og.png')({
	server: { handlers: { GET: docDetailOgImageHttp } },
})
