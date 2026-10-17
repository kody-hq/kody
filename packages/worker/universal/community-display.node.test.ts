import { afterEach, expect, test, vi } from 'vitest'
import { formatCommunityPublishedDate } from './community-display.ts'

afterEach(() => vi.unstubAllEnvs())

test.each(['UTC', 'Pacific/Honolulu', 'Pacific/Auckland'])(
	'publication and joined dates interpret SQLite timestamps as UTC in %s',
	(timezone) => {
		vi.stubEnv('TZ', timezone)
		expect(formatCommunityPublishedDate('2026-10-12 23:30:00')).toBe(
			'October 12, 2026',
		)
		expect(formatCommunityPublishedDate('2026-10-12 00:30:00')).toBe(
			'October 12, 2026',
		)
		expect(formatCommunityPublishedDate('2026-10-12T23:30:00Z')).toBe(
			'October 12, 2026',
		)
		expect(formatCommunityPublishedDate('2026-10-13T01:30:00+02:00')).toBe(
			'October 12, 2026',
		)
	},
)
