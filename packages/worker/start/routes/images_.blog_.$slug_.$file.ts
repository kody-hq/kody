import { createFileRoute } from '@tanstack/react-router'
import { blogImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/images_/blog_/$slug_/$file')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: blogImageHttp, HEAD: blogImageHttp } },
})
