import { createPageQuery } from './page-query.ts'
import { loadPackageWebhooks } from '#start/server/package-webhooks'
export const packageWebhooksQuery = createPageQuery(
	'loadPackageWebhooks',
	loadPackageWebhooks,
	{ staleTime: 30_000, freshAuthorization: true },
)
