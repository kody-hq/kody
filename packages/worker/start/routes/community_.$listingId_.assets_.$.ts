import { createFileRoute } from '@tanstack/react-router'
import { communityDetailAssetHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/community_/$listingId_/assets_/$')({
	server: { handlers: { GET: communityDetailAssetHttp } },
})
