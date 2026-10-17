import { createFileRoute } from '@tanstack/react-router'
import { communityDetailIconHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/community_/$listingId_/icon_/$iconCommit',
)({ server: { handlers: { GET: communityDetailIconHttp } } })
