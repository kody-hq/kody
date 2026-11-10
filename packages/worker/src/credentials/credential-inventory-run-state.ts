import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const credentialInventoryRunState = setup({
	schemas: { events: { SCAN_PAGE: types<{}>(), COMPLETE: types<{}>() } },
}).createMachine({
	id: 'credential_inventory_runs.status',
	description:
		'Inventory scans advance a cursor while scanning and complete at the last page.',
	initial: 'scanning',
	states: {
		scanning: {
			on: {
				SCAN_PAGE: { target: 'scanning' },
				COMPLETE: { target: 'complete' },
			},
		},
		complete: { type: 'final' },
	},
})

export type CredentialInventoryRunStatus = LifecycleStateOf<
	typeof credentialInventoryRunState
>
