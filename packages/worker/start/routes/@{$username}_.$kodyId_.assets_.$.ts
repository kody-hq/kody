import { createFileRoute } from '@tanstack/react-router'
import { communityPackageAssetHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/@{$username}_/$kodyId_/assets_/$')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: communityPackageAssetHttp } },
})
