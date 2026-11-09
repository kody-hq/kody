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
	{ machine: runState, file: 'packages/worker/src/run-records/run-state.ts' },
	{
		machine: d1PacedRestoreDrillRunState,
		file: 'packages/worker/src/dr/d1-paced-restore-drill-run-state.ts',
	},
	{
		machine: packageOwnerSpikeState,
		file: 'packages/worker/src/usage/package-owner-spike-state.ts',
	},
] as const
