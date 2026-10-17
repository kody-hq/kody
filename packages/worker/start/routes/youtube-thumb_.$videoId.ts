import { createFileRoute } from '@tanstack/react-router'
import { youtubeThumbHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/youtube-thumb_/$videoId')({
	server: { handlers: { GET: youtubeThumbHttp } },
})
