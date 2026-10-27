import { createPageQuery } from './page-query.ts'
import { loadPackageForks } from '#start/server/package-forks'
export const forksPageQuery = createPageQuery(
	'loadPackageForks',
	loadPackageForks,
	{ freshAuthorization: true },
)
