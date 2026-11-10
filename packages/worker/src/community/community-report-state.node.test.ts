import {
	canHandle,
	finalStatesOf,
	sqlSourcesOf,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'

import { expect, test } from 'vitest'
import { communityReportState } from './community-report-state.ts'

test('community_reports.status resolves or dismisses an open report once', () => {
	expect(canHandle(communityReportState, 'open', 'CREATE' as never)).toBe(false)
	expect(canHandle(communityReportState, 'resolved', 'DISMISS')).toBe(false)
	expect(finalStatesOf(communityReportState).includes('resolved')).toBe(true)
	expect(finalStatesOf(communityReportState).includes('dismissed')).toBe(true)
	expect(sqlSourcesOf(communityReportState, 'RESOLVE', ['open'])).toBe(
		"('open')",
	)
	expect(() =>
		sqlSourcesOf(communityReportState, 'CREATE' as never, ['resolved']),
	).toThrow(IllegalStateTransitionError)
})
