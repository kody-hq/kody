import { createPageQuery } from './page-query.ts'
import {
	loadConnectSecrets,
	loadConnectWebhookApply,
} from '#start/server/connect'
export const connectSecretsQuery = createPageQuery(
	'loadConnectSecrets',
	loadConnectSecrets,
	{ staleTime: 0, freshAuthorization: true },
)
export const connectWebhookApplyQuery = createPageQuery(
	'loadConnectWebhookApply',
	loadConnectWebhookApply,
	{ staleTime: 0, freshAuthorization: true },
)
