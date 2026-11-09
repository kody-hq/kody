import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const credentialInventoryRunState = defineStateMachine({
	name: 'credential_inventory_runs.status',
	description:
		'Inventory scans advance a cursor while scanning and complete at the last page.',
	initial: 'scanning',
	transitions: { scanning: ['scanning', 'complete'], complete: [] },
})

export type CredentialInventoryRunStatus = StateOf<
	typeof credentialInventoryRunState
>
