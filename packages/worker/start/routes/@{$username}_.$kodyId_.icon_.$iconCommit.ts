import { createFileRoute } from '@tanstack/react-router'
import { communityPackageIconHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/@{$username}_/$kodyId_/icon_/$iconCommit',
)({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: communityPackageIconHttp } },
})
