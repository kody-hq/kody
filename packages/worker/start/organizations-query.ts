import { loadOrganizations } from '#start/server/org-organizations'
import { createPageQuery } from './page-query.ts'

export const organizationsQuery = createPageQuery(
	'loadOrganizations',
	loadOrganizations,
	{ freshAuthorization: true },
)
