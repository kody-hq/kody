import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { orgDeleteCapability } from './org-delete.ts'
import { orgRestoreCapability } from './org-restore.ts'
import { orgUpdateCapability } from './org-update.ts'
import {
	packageSessionInsightsCapability,
	sessionInsightsDeleteCapability,
	sessionInsightsGetCapability,
} from './session-insights.ts'
import { resourceRestoreCapability } from './resource-restore.ts'
import { packageAppCustomHostnameAddCapability } from './package-app-custom-hostname-add.ts'
import { packageAppCustomHostnameDeleteCapability } from './package-app-custom-hostname-delete.ts'
import { packageAppCustomHostnameListCapability } from './package-app-custom-hostname-list.ts'
import { packageAppCustomHostnameSyncCapability } from './package-app-custom-hostname-sync.ts'

export const orgsDomain = defineDomain({
	name: capabilityDomainNames.orgs,
	description:
		'Organization lifecycle: profile, soft delete, restore, resource restore, package-app custom domains, and session analytics insights.',
	keywords: [
		'org',
		'organization',
		'team',
		'soft delete',
		'restore',
		'purge',
		'custom domain',
		'hostname',
		'session analytics',
	],
	capabilities: [
		orgUpdateCapability,
		orgDeleteCapability,
		orgRestoreCapability,
		resourceRestoreCapability,
		sessionInsightsGetCapability,
		sessionInsightsDeleteCapability,
		packageSessionInsightsCapability,
		packageAppCustomHostnameAddCapability,
		packageAppCustomHostnameListCapability,
		packageAppCustomHostnameSyncCapability,
		packageAppCustomHostnameDeleteCapability,
	],
})
