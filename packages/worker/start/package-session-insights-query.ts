import { createPageQuery } from './page-query.ts'
import { loadPackageSessionInsights } from '#start/server/package-session-insights'
export const packageSessionInsightsQuery = createPageQuery(
	'loadPackageSessionInsights',
	loadPackageSessionInsights,
	{ staleTime: 60_000, freshAuthorization: true },
)
