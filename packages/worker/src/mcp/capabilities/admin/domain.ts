import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminCommunityActivityListCapability } from './admin-community-activity-list.ts'
import { adminCreditEligibilitySetCapability } from './admin-credit-eligibility-set.ts'
import { adminCreditGrantCapability } from './admin-credit-grant.ts'
import { adminCreditWalletGetCapability } from './admin-credit-wallet-get.ts'
import { adminOrgLimitOverridesSetCapability } from './admin-org-limit-overrides-set.ts'
import { adminOrgLimitsGetCapability } from './admin-org-limits-get.ts'
import { adminOrgResourceTransferCapability } from './admin-org-resource-transfer.ts'
import { adminOrgRestoreCapability } from './admin-org-restore.ts'
import { adminCommunityOrphanForksCleanupCapability } from './admin-community-orphan-forks-cleanup.ts'
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import {
	adminFeatureFlagRepoCheckCapability,
	adminFeatureFlagRepoOverrideCapability,
} from './admin-feature-flag-repo-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'
import { adminPackageCodemodApplyCapability } from './admin-package-codemod-apply.ts'
import { adminPackageCodemodDryRunCapability } from './admin-package-codemod-dry-run.ts'
import { adminPackageCodemodOwnerNoticeCapability } from './admin-package-codemod-owner-notice.ts'
import { adminPackageCodemodRevertCapability } from './admin-package-codemod-revert.ts'
import { adminPackageCodemodScanCapability } from './admin-package-codemod-scan.ts'
import { adminPackagePlacementFailuresCapability } from './admin-package-placement-failures.ts'
import { adminPlatformOauthAppDeleteCapability } from './admin-platform-oauth-app-delete.ts'
import { adminPlatformOauthAppListCapability } from './admin-platform-oauth-app-list.ts'
import { adminPlatformOauthAppSaveCapability } from './admin-platform-oauth-app-save.ts'
import { adminPlatformProviderMarkDeleteCapability } from './admin-platform-provider-mark-delete.ts'
import { adminPlatformProviderMarkListCapability } from './admin-platform-provider-mark-list.ts'
import { adminPlatformProviderMarkSaveCapability } from './admin-platform-provider-mark-save.ts'
import { adminPlatformFeedbackGetCapability } from './admin-platform-feedback-get.ts'
import { adminPlatformFeedbackListCapability } from './admin-platform-feedback-list.ts'
import { adminPlatformFeedbackUpdateCapability } from './admin-platform-feedback-update.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminOrgUsageCapability } from './admin-org-usage.ts'
import { adminUserOauthGrantsCapability } from './admin-user-oauth-grants.ts'
import { adminOauthGrantsLackingOrgIdRevokeCapability } from './admin-oauth-grants-lacking-org-id-revoke.ts'
import { adminSystemEmailDeleteCapability } from './admin-system-email-delete.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import { adminSystemEmailSendCapability } from './admin-system-email-send.ts'
import { adminSystemEmailSenderRuleDeleteCapability } from './admin-system-email-sender-rule-delete.ts'
import { adminSystemEmailSenderRuleListCapability } from './admin-system-email-sender-rule-list.ts'
import { adminSystemEmailSenderRuleSetCapability } from './admin-system-email-sender-rule-set.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminHandleGetCapability } from './admin-handle-get.ts'
import { adminOauthConnectionHostsListCapability } from './admin-oauth-connection-hosts-list.ts'
import { adminWebhookRejectionReportCapability } from './admin-webhook-rejection-report.ts'
import { adminWebhookVerificationScanCapability } from './admin-webhook-verification-scan.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { adminUserAccountDeleteCapability } from './admin-user-account-delete.ts'
import { adminUserVerifyCapability } from './admin-user-verify.ts'
import { adminEmailDestinationVerifyCapability } from './admin-email-destination-verify.ts'
import { adminAccountDeletionAbortCapability } from './admin-account-deletion-abort.ts'
import { adminAccountWriteLeaseListCapability } from './admin-account-write-lease-list.ts'
import { adminAccountWriteLeaseRepairCapability } from './admin-account-write-lease-repair.ts'
import { adminUserMeterParityCapability } from './admin-user-meter-parity.ts'
import { adminRunLogSqlBillingCapability } from './admin-run-log-sql-billing.ts'
import { adminUserMeterStorageReconcileCapability } from './admin-user-meter-storage-reconcile.ts'
import { adminMailboxMaintenanceCapability } from './admin-mailbox-maintenance.ts'
import { adminReservedUsernameAddCapability } from './admin-reserved-username-add.ts'
import { adminReservedUsernameListCapability } from './admin-reserved-username-list.ts'
import { adminReservedUsernameRemoveCapability } from './admin-reserved-username-remove.ts'
import { adminUnverifiedAccountPurgeRunCapability } from './admin-unverified-account-purge-run.ts'
import { adminSoftDeletePurgeRunCapability } from './admin-soft-delete-purge-run.ts'
import { adminPublishedImportableArtifactBackfillCapability } from './admin-published-importable-artifact-backfill.ts'
import { adminPublishedSourceSnapshotBackfillCapability } from './admin-published-source-snapshot-backfill.ts'
import { adminCredentialInventoryScanCapability } from './admin-credential-inventory-scan.ts'
import { adminCredentialBackfillCapability } from './admin-credential-backfill.ts'
import { adminCredentialStampBackfillCapability } from './admin-credential-stamp-backfill.ts'
import { adminCredentialStampMigrateCapability } from './admin-credential-stamp-migrate.ts'
import { adminJobOwnerEnablementBackfillCapability } from './admin-job-owner-enablement-backfill.ts'
import { adminMemoryPersonalizeCopyCapability } from './admin-memory-personalize-copy.ts'
import { adminMemoryPersonalizePurgeCapability } from './admin-memory-personalize-purge.ts'

export const adminDomain = defineDomain({
	name: capabilityDomainNames.admin,
	description:
		'Admin-only operator tools for accounts, flags, maintenance, and community metadata.',
	keywords: [
		'admin',
		'rbac',
		'account metadata',
		'users',
		'roles',
		'plans',
		'email verification',
		'verify',
		'audit',
		'feature flags',
		'system email',
		'platform feedback',
		'community activity',
		'orphan forks',
		'platform oauth apps',
		'provider marks',
		'codemod',
		'package codemod',
		'fleet',
		'migration',
		'user meter',
		'parity',
		'run log',
		'sql billing',
		'placement refusal',
		'cutover',
		'reconcile',
		'storage bytes',
		'mailbox',
		'maintenance',
		'retention',
		'unverified account purge',
		'soft delete purge',
		'published importable artifact backfill',
		'published source snapshot backfill',
		'missing artifacts',
		'missing snapshot',
		'reserved username',
		'handle',
		'org slug',
		'credits',
		'credit grant',
		'credit eligibility',
		'limit overrides',
		'org limits',
		'org transfer',
		'move org resources',
		'credential inventory',
		'credential backfill',
		'job owner enablement backfill',
		'cron enablement backfill',
		'memory personalize',
		'memory copy',
		'personal memory migration',
		'org usage',
		'org restore',
		'account delete',
		'hard delete',
		'delete account',
		'oauth grants',
		'grant bindings',
		'oauth grants lacking orgId',
		'revoke oauth orgId fallback',
	],
	capabilities: [
		adminUserListCapability,
		adminUserGetCapability,
		adminHandleGetCapability,
		adminOauthConnectionHostsListCapability,
		adminWebhookRejectionReportCapability,
		adminWebhookVerificationScanCapability,
		adminUserCreateCapability,
		adminUserUpdateCapability,
		adminUserAccountDeleteCapability,
		adminUserVerifyCapability,
		adminEmailDestinationVerifyCapability,
		adminUserMeterParityCapability,
		adminRunLogSqlBillingCapability,
		adminPackagePlacementFailuresCapability,
		adminUserMeterStorageReconcileCapability,
		adminMailboxMaintenanceCapability,
		adminAccountWriteLeaseListCapability,
		adminAccountWriteLeaseRepairCapability,
		adminAccountDeletionAbortCapability,
		adminUnverifiedAccountPurgeRunCapability,
		adminSoftDeletePurgeRunCapability,
		adminPlatformOauthAppSaveCapability,
		adminPlatformOauthAppListCapability,
		adminPlatformOauthAppDeleteCapability,
		adminPlatformProviderMarkSaveCapability,
		adminPlatformProviderMarkListCapability,
		adminPlatformProviderMarkDeleteCapability,
		adminPackageCodemodScanCapability,
		adminPackageCodemodDryRunCapability,
		adminPackageCodemodApplyCapability,
		adminPackageCodemodRevertCapability,
		adminPackageCodemodOwnerNoticeCapability,
		adminPublishedImportableArtifactBackfillCapability,
		adminPublishedSourceSnapshotBackfillCapability,
		adminCredentialInventoryScanCapability,
		adminCredentialBackfillCapability,
		adminCredentialStampBackfillCapability,
		adminCredentialStampMigrateCapability,
		adminJobOwnerEnablementBackfillCapability,
		adminMemoryPersonalizeCopyCapability,
		adminMemoryPersonalizePurgeCapability,
		adminAuditLogQueryCapability,
		adminUserUsageCapability,
		adminOrgUsageCapability,
		adminUserOauthGrantsCapability,
		adminOauthGrantsLackingOrgIdRevokeCapability,
		adminCreditWalletGetCapability,
		adminCreditGrantCapability,
		adminCreditEligibilitySetCapability,
		adminOrgLimitsGetCapability,
		adminOrgLimitOverridesSetCapability,
		adminFeatureFlagListCapability,
		adminFeatureFlagSetCapability,
		adminFeatureFlagOverrideCapability,
		adminFeatureFlagRepoOverrideCapability,
		adminFeatureFlagRepoCheckCapability,
		adminReservedUsernameListCapability,
		adminReservedUsernameAddCapability,
		adminReservedUsernameRemoveCapability,
		adminSystemEmailListCapability,
		adminSystemEmailGetCapability,
		adminSystemEmailDeleteCapability,
		adminSystemEmailSendCapability,
		adminSystemEmailSenderRuleListCapability,
		adminSystemEmailSenderRuleSetCapability,
		adminSystemEmailSenderRuleDeleteCapability,
		adminPlatformFeedbackListCapability,
		adminPlatformFeedbackGetCapability,
		adminPlatformFeedbackUpdateCapability,
		adminCommunityActivityListCapability,
		adminCommunityOrphanForksCleanupCapability,
		adminOrgResourceTransferCapability,
		adminOrgRestoreCapability,
	],
})
