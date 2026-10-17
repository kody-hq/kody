import { createPageQuery } from './page-query.ts'
import { loadConnectionUsagePage } from '#start/server/connection-usage'
const usageQuery = createPageQuery(
	'loadConnectionUsagePage',
	loadConnectionUsagePage,
	{ staleTime: 30_000 },
)
export function connectionUsageQuery(actorKey: string | null, orgSlug: string) {
	return usageQuery(actorKey, { orgSlug })
}
