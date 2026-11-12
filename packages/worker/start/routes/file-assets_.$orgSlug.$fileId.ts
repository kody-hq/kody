import { createFileRoute } from '@tanstack/react-router'
import { fileAssetHttp } from '#start/server/file-assets'
export const Route = createFileRoute('/file-assets_/$orgSlug/$fileId')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: fileAssetHttp, HEAD: fileAssetHttp } },
})
