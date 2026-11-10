import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const communityReportState = setup({
	schemas: { events: { RESOLVE: types<{}>(), DISMISS: types<{}>() } },
}).createMachine({
	id: 'community_reports.status',
	description: 'Open community reports resolve or dismiss once.',
	initial: 'open',
	states: {
		open: {
			on: { RESOLVE: { target: 'resolved' }, DISMISS: { target: 'dismissed' } },
		},
		resolved: { type: 'final' },
		dismissed: { type: 'final' },
	},
})

export type CommunityReportStatus = LifecycleStateOf<
	typeof communityReportState
>
