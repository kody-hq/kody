import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const communityReportState = defineStateMachine({
	name: 'community_reports.status',
	description: 'Open community reports resolve or dismiss once.',
	initial: 'open',
	transitions: { open: ['resolved', 'dismissed'], resolved: [], dismissed: [] },
})

export type CommunityReportStatus = StateOf<typeof communityReportState>
