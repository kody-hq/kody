import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { accountExportManifestCapability } from './account-export-manifest.ts'
import { accountExportSectionCapability } from './account-export-section.ts'
import {
	guestClaimFinishCapability,
	guestClaimStartCapability,
} from './guest-claim.ts'
import { usageByPackageGetCapability } from './usage-by-package-get.ts'
import { usageGetCapability } from './usage-get.ts'
import { usageTrendGetCapability } from './usage-trend-get.ts'
import { waitingSummaryCapability } from './waiting-summary.ts'

export const accountDomain = defineDomain({
	name: capabilityDomainNames.account,
	description:
		'Self-service account export, backup, migration, entitlement usage, daily usage trends, package credit attribution, and the current-state waiting queue (secrets never exported).',
	keywords: [
		'account',
		'export',
		'backup',
		'migration',
		'privacy',
		'usage',
		'trend',
		'by package',
		'attribution',
		'quota',
		'waiting',
		'approvals',
		'blockers',
		'guest',
		'claim',
	],
	capabilities: [
		accountExportManifestCapability,
		accountExportSectionCapability,
		usageGetCapability,
		usageTrendGetCapability,
		usageByPackageGetCapability,
		waitingSummaryCapability,
		guestClaimStartCapability,
		guestClaimFinishCapability,
	],
})
