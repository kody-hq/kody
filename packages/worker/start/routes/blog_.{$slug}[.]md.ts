import { createFileRoute } from '@tanstack/react-router'
import { blogPostMarkdownHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/blog_/{$slug}.md')({
	server: { handlers: { GET: blogPostMarkdownHttp } },
})
