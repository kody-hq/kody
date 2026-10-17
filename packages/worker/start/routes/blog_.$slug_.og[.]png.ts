import { createFileRoute } from '@tanstack/react-router'
import { blogPostOgImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/blog_/$slug_/og.png')({
	server: { handlers: { GET: blogPostOgImageHttp } },
})
