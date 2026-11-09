import { IllegalStateTransitionError } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { communityReportState } from './community-report-state.ts'

test('community_reports.status resolves or dismisses an open report once', () => {
	expect(communityReportState.can('open', 'open')).toBe(false)
	expect(communityReportState.can('resolved', 'dismissed')).toBe(false)
	expect(communityReportState.isTerminal('resolved')).toBe(true)
	expect(communityReportState.isTerminal('dismissed')).toBe(true)
	expect(
		communityReportState.guard({
			from: 'open',
			to: ['resolved', 'dismissed'],
		}),
	).toBe("('open')")
	expect(() =>
		communityReportState.guard({ from: 'resolved', to: 'open' }),
	).toThrow(IllegalStateTransitionError)
})
