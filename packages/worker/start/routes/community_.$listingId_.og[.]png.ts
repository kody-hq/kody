import { createFileRoute } from '@tanstack/react-router'
import { communityDetailOgImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/community_/$listingId_/og.png')({
	server: { handlers: { GET: communityDetailOgImageHttp } },
})
