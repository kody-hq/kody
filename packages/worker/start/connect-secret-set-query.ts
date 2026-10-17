import { createPageQuery } from './page-query.ts'
import { loadConnectSecretSet } from '#start/server/connect-secret-set'

export const connectSecretSetQuery = createPageQuery(
	'loadConnectSecretSet',
	loadConnectSecretSet,
	{ freshAuthorization: true },
)
