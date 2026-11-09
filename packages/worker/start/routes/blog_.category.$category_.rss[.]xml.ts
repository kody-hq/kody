import { createFileRoute } from '@tanstack/react-router'
import { blogCategoryRssHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/blog_/category/$category_/rss.xml')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: blogCategoryRssHttp } },
})
