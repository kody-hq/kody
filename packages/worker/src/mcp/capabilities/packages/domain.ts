import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { approvalBundleCreateCapability } from './approval-bundle-create.ts'
import { approvalPendingListCapability } from './approval-pending-list.ts'
import { deletePackageCapability } from './delete-package.ts'
import { enablementDisableCapability } from './enablement-disable.ts'
import { enablementEnableCapability } from './enablement-enable.ts'
import { enablementListCapability } from './enablement-list.ts'
import { getGitRemoteCapability } from './get-git-remote.ts'
import { getPackageCapability } from './get-package.ts'
import { listPackagesCapability } from './list-packages.ts'
import { listPackageSubscriptionsCapability } from './list-package-subscriptions.ts'
import { packageAppFetchCapability } from './package-app-fetch.ts'
import { packageCheckCapability } from './package-check.ts'
import { packageSubscriptionDispatchCapability } from './package-subscription-dispatch.ts'
import { packageUpdateCapability } from './package-update.ts'
import { publishExternalPushCapability } from './publish-external-push.ts'
import { savePackageCapability } from './save-package.ts'
import { packageSecurityAuditRecordCapability } from './security-audit-record.ts'

export const packagesDomain = defineDomain({
	name: capabilityDomainNames.packages,
	description:
		'Repo-backed saved packages with config, storage, apps, jobs, and subscriptions.',
	keywords: [
		'package',
		'repo',
		'package.json',
		'exports',
		'jobs',
		'app',
		'subscriptions',
		'event handlers',
		'invite',
		'test',
		'smoke',
		'simulate',
		'probe',
		'synthetic',
		'enablement',
		'enable',
		'approval',
		'approve',
	],
	capabilities: [
		savePackageCapability,
		getPackageCapability,
		getGitRemoteCapability,
		listPackagesCapability,
		listPackageSubscriptionsCapability,
		packageAppFetchCapability,
		packageSubscriptionDispatchCapability,
		packageUpdateCapability,
		publishExternalPushCapability,
		packageCheckCapability,
		deletePackageCapability,
		packageSecurityAuditRecordCapability,
		enablementListCapability,
		enablementEnableCapability,
		enablementDisableCapability,
		approvalPendingListCapability,
		approvalBundleCreateCapability,
	],
})
