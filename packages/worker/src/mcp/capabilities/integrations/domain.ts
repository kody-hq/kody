import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationLockCapability } from './integration-lock.ts'
import { integrationOauthAppDeleteCapability } from './integration-oauth-app-delete.ts'
import { integrationOauthAppListCapability } from './integration-oauth-app-list.ts'
import { integrationOauthAppRotateCredentialsCapability } from './integration-oauth-app-rotate-credentials.ts'
import { integrationPlatformAppListCapability } from './integration-platform-app-list.ts'
import { integrationDeviceConnectPollCapability } from './integration-device-connect-poll.ts'
import { integrationDeviceConnectStartCapability } from './integration-device-connect-start.ts'
import { integrationSaveCapability } from './integration-save.ts'
import { integrationTokenRefreshCapability } from './integration-token-refresh.ts'

export const integrationsDomain = defineDomain({
	name: capabilityDomainNames.integrations,
	description: 'Saved OAuth configs and provider connections.',
	keywords: [
		'integration',
		'oauth',
		'provider',
		'connect',
		'token',
		'api',
		'third-party',
		'oauth app',
		'client credentials',
		'device',
		'lock',
		'usage',
	],
	capabilities: [
		integrationSaveCapability,
		integrationGetCapability,
		integrationListCapability,
		integrationLockCapability,
		integrationDeleteCapability,
		integrationOauthAppListCapability,
		integrationOauthAppDeleteCapability,
		integrationOauthAppRotateCredentialsCapability,
		integrationPlatformAppListCapability,
		integrationTokenRefreshCapability,
		integrationDeviceConnectStartCapability,
		integrationDeviceConnectPollCapability,
	],
})
