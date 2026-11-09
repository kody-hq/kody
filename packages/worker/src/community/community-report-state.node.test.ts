import { expect, test } from 'vitest'
import { communityReportState } from './community-report-state.ts'

test('community_reports.status preserves the lifecycle graph', () => {
	expect(communityReportState.initial).toEqual(['open'])
	expect(communityReportState.transitions).toEqual({
		open: ['resolved', 'dismissed'],
		resolved: [],
		dismissed: [],
	})
	expect(communityReportState.terminal).toEqual(['resolved', 'dismissed'])
})
