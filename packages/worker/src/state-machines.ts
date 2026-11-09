import { deviceAuthorizationState } from './oauth-device/device-authorization-state.ts'
import { agentRegistrationState } from './agent-registration/agent-registration-state.ts'
import { inviteState } from './orgs/invite-state.ts'

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
] as const
