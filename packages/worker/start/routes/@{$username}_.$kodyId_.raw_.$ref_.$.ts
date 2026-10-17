import { createFileRoute } from '@tanstack/react-router'
import { communityPackageRawHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/@{$username}_/$kodyId_/raw_/$ref_/$')({
	server: { handlers: { GET: communityPackageRawHttp } },
})
