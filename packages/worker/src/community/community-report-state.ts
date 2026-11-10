import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const communityReportState = setup({
	types: {
		events: {} as { type: 'RESOLVE' } | { type: 'DISMISS' },
	},
}).createMachine({
	id: 'community_reports.status',
	description: 'Open community reports resolve or dismiss once.',
	initial: 'open',
	states: {
		open: { on: { RESOLVE: 'resolved', DISMISS: 'dismissed' } },
		resolved: { type: 'final' },
		dismissed: { type: 'final' },
	},
})

export type CommunityReportStatus = LifecycleStateOf<
	typeof communityReportState
>
