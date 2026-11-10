import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const credentialInventoryRunState = setup({
	types: {
		events: {} as { type: 'SCAN_PAGE' } | { type: 'COMPLETE' },
	},
}).createMachine({
	id: 'credential_inventory_runs.status',
	description:
		'Inventory scans advance a cursor while scanning and complete at the last page.',
	initial: 'scanning',
	states: {
		scanning: { on: { SCAN_PAGE: 'scanning', COMPLETE: 'complete' } },
		complete: { type: 'final' },
	},
})

export type CredentialInventoryRunStatus = LifecycleStateOf<
	typeof credentialInventoryRunState
>
