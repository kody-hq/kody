import { createFileRoute } from '@tanstack/react-router'
import { communityDetailRawHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/community_/$listingId_/raw_/$')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: communityDetailRawHttp } },
})
