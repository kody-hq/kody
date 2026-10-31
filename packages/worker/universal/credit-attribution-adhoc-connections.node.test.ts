import { expect, test } from 'vitest'
import {
	creditAttributionAdHocConnectionLimit,
	summarizeAdHocConnectionUsage,
} from '#universal/credit-attribution.ts'

test('groups Ad hoc worker units by connection label, heaviest first', () => {
	const summary = summarizeAdHocConnectionUsage({
		sinceDay: '2026-10-18',
		rows: [
			{ credentialKind: 'cli', credentialId: 'cli-a', units: 3 },
			{ credentialKind: 'cli', credentialId: 'cli-b', units: 4 },
			{
				credentialKind: 'mcp-oauth',
				credentialId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
				units: 40,
			},
			{ credentialKind: 'schedule', credentialId: 'job-1', units: 2 },
			{ credentialKind: '', credentialId: '', units: 1 },
			{ credentialKind: 'api-token', credentialId: 'tok', units: 0 },
		],
	})
	expect(summary.sinceDay).toBe('2026-10-18')
	expect(summary.rows.map((row) => [row.label, row.workerUnits])).toEqual([
		['MCP agent · claude.ai · mcp-oauth-client-metadata', 40],
		['Kody CLI', 7],
		['Scheduled job', 2],
		['Unattributed (before connection tracking)', 1],
	])
	expect(summary.otherWorkerUnits).toBe(0)
})

test('folds connections past the limit into otherWorkerUnits', () => {
	const rows = Array.from(
		{ length: creditAttributionAdHocConnectionLimit + 2 },
		(_, index) => ({
			credentialKind: 'mcp-oauth',
			credentialId: `https://agent-${index}.example/client.json`,
			units: index + 1,
		}),
	)
	const summary = summarizeAdHocConnectionUsage({
		sinceDay: '2026-10-01',
		rows,
	})
	expect(summary.rows).toHaveLength(creditAttributionAdHocConnectionLimit)
	expect(summary.rows[0]?.workerUnits).toBe(rows.length)
	expect(summary.otherWorkerUnits).toBe(1 + 2)
})
