import { createPageQuery } from './page-query.ts'
import { loadPackageAppConnectedPeople } from '#start/server/package-app-connected-people'
export const connectedPeoplePageQuery = createPageQuery(
	'loadPackageAppConnectedPeople',
	loadPackageAppConnectedPeople,
	{ freshAuthorization: true },
)
