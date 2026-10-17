import { createPageQuery } from './page-query.ts'
import { loadPackageCollaborators } from '#start/server/package-collaborators'
export const collaboratorsPageQuery = createPageQuery(
	'loadPackageCollaborators',
	loadPackageCollaborators,
	{ freshAuthorization: true },
)
