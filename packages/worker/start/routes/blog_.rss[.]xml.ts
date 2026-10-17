import { createFileRoute } from '@tanstack/react-router'
import { blogRssHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/blog_/rss.xml')({
	server: { handlers: { GET: blogRssHttp } },
})
