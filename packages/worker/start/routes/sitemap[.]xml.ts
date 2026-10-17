import { createFileRoute } from '@tanstack/react-router'
import { sitemapHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/sitemap.xml')({
	server: { handlers: { GET: sitemapHttp } },
})
