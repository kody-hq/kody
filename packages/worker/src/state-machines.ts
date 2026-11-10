import { deviceAuthorizationState } from './oauth-device/device-authorization-state.ts'
import { agentRegistrationState } from './agent-registration/agent-registration-state.ts'
import { inviteState } from './orgs/invite-state.ts'
import { publishBuildState } from './publish-offload/publish-build-state.ts'
import { deadLetterMessageState } from './dead-letter/dead-letter-message-state.ts'
import { packageApprovalState } from './package-capabilities/package-approval-state.ts'
import { planTransferState } from './billing/plan-transfer-state.ts'
import { packageCodemodRunState } from './package-codemods/package-codemod-run-state.ts'
import { runState } from './run-records/run-state.ts'
import { d1PacedRestoreDrillRunState } from './dr/d1-paced-restore-drill-run-state.ts'
import { packageOwnerSpikeState } from './usage/package-owner-spike-state.ts'

import { accountDeletionApprovalState } from '#universal/account-deletion-approval-state.ts'
import { communityListingState } from './community/community-listing-state.ts'
import { communityReportState } from './community/community-report-state.ts'
import { credentialInventoryRunState } from './credentials/credential-inventory-run-state.ts'
import { d1PacedRestoreDrillSourceState } from './dr/d1-paced-restore-drill-source-state.ts'
import { emailProcessingState } from './email/email-processing-state.ts'
import { inboundDedupePointerState } from './email/inbound-dedupe-pointer-state.ts'
import { inboundDeliveryState } from './email/inbound-delivery-state.ts'
import { inboundSubscriptionEffectState } from './email/inbound-subscription-effect-state.ts'
import { enablementState } from './enablements/enablement-state.ts'
import { referralState } from './entitlements/referral-state.ts'
import { queuedRunState } from './execution-contexts/queued-run-state.ts'
import { runDispatchState } from './execution-contexts/run-dispatch-state.ts'
import { followState } from './follow/follow-state.ts'
import { emailClaimState } from './identity/email-claim-state.ts'
import { memoryState } from './mcp/memory/memory-state.ts'
import { inviteLinkState } from './orgs/invite-link-state.ts'
import { platformFeedbackState } from './platform-feedback/platform-feedback-state.ts'
import { repoSessionState } from './repo/repo-session-state.ts'
import { packageInvocationState } from './run-records/package-invocation-state.ts'
import { usageCampaignState } from './usage/usage-campaign-state.ts'

/** Event-driven XState machines registered for graph docs and tests. */
export const stateMachines = [
	{
		machine: deviceAuthorizationState,
		file: 'packages/worker/src/oauth-device/device-authorization-state.ts',
	},
	{
		machine: agentRegistrationState,
		file: 'packages/worker/src/agent-registration/agent-registration-state.ts',
	},
	{ machine: inviteState, file: 'packages/worker/src/orgs/invite-state.ts' },
	{
		machine: publishBuildState,
		file: 'packages/worker/src/publish-offload/publish-build-state.ts',
	},
	{
		machine: deadLetterMessageState,
		file: 'packages/worker/src/dead-letter/dead-letter-message-state.ts',
	},
	{
		machine: packageApprovalState,
		file: 'packages/worker/src/package-capabilities/package-approval-state.ts',
	},
	{
		machine: planTransferState,
		file: 'packages/worker/src/billing/plan-transfer-state.ts',
	},
	{
		machine: packageCodemodRunState,
		file: 'packages/worker/src/package-codemods/package-codemod-run-state.ts',
	},
	{
		machine: d1PacedRestoreDrillRunState,
		file: 'packages/worker/src/dr/d1-paced-restore-drill-run-state.ts',
	},
	{
		machine: packageOwnerSpikeState,
		file: 'packages/worker/src/usage/package-owner-spike-state.ts',
	},
	{
		machine: accountDeletionApprovalState,
		file: 'packages/worker/universal/account-deletion-approval-state.ts',
	},
	{
		machine: communityReportState,
		file: 'packages/worker/src/community/community-report-state.ts',
	},
	{
		machine: credentialInventoryRunState,
		file: 'packages/worker/src/credentials/credential-inventory-run-state.ts',
	},
	{
		machine: d1PacedRestoreDrillSourceState,
		file: 'packages/worker/src/dr/d1-paced-restore-drill-source-state.ts',
	},
	{
		machine: inboundDedupePointerState,
		file: 'packages/worker/src/email/inbound-dedupe-pointer-state.ts',
	},
	{
		machine: inboundDeliveryState,
		file: 'packages/worker/src/email/inbound-delivery-state.ts',
	},
	{
		machine: inboundSubscriptionEffectState,
		file: 'packages/worker/src/email/inbound-subscription-effect-state.ts',
	},
	{
		machine: enablementState,
		file: 'packages/worker/src/enablements/enablement-state.ts',
	},
	{
		machine: referralState,
		file: 'packages/worker/src/entitlements/referral-state.ts',
	},
	{
		machine: queuedRunState,
		file: 'packages/worker/src/execution-contexts/queued-run-state.ts',
	},
	{
		machine: runDispatchState,
		file: 'packages/worker/src/execution-contexts/run-dispatch-state.ts',
	},
	{ machine: followState, file: 'packages/worker/src/follow/follow-state.ts' },
	{
		machine: emailClaimState,
		file: 'packages/worker/src/identity/email-claim-state.ts',
	},
	{
		machine: inviteLinkState,
		file: 'packages/worker/src/orgs/invite-link-state.ts',
	},
	{
		machine: platformFeedbackState,
		file: 'packages/worker/src/platform-feedback/platform-feedback-state.ts',
	},
	{
		machine: packageInvocationState,
		file: 'packages/worker/src/run-records/package-invocation-state.ts',
	},
] as const

/** Unconstrained status columns (`defineStatusEnum`); no transition graph. */
export const statusEnums = [
	{
		statusEnum: runState,
		file: 'packages/worker/src/run-records/run-state.ts',
	},
	{
		statusEnum: communityListingState,
		file: 'packages/worker/src/community/community-listing-state.ts',
	},
	{
		statusEnum: emailProcessingState,
		file: 'packages/worker/src/email/email-processing-state.ts',
	},
	{
		statusEnum: repoSessionState,
		file: 'packages/worker/src/repo/repo-session-state.ts',
	},
	{
		statusEnum: usageCampaignState,
		file: 'packages/worker/src/usage/usage-campaign-state.ts',
	},
	{
		statusEnum: memoryState,
		file: 'packages/worker/src/mcp/memory/memory-state.ts',
	},
] as const
