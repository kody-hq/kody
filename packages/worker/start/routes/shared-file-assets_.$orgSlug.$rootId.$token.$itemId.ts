import { createFileRoute } from '@tanstack/react-router'
import { publicFileAssetHttp } from '#start/server/public-file-assets'
export const Route = createFileRoute(
	'/shared-file-assets_/$orgSlug/$rootId/$token/$itemId',
)({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: publicFileAssetHttp, HEAD: publicFileAssetHttp } },
})
