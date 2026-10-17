import { expect, test } from 'vitest'
import { accountConnectionsUsageHref } from './account-connections.ts'
import {
	connectionUsageEntryLabel,
	connectionUsageHasActivity,
	connectionUsageOtherCounts,
	formatConnectionUsageQuantity,
} from './connection-usage-presentation.ts'
import { type ConnectionUsageTotals } from './connection-usage.ts'

function totals(
	last7Days: Partial<ConnectionUsageTotals['last7Days']>,
): ConnectionUsageTotals {
	const empty = { executeCalls: 0, workerLoads: 0, runs: 0 }
	return {
		today: empty,
		capWeek: empty,
		last7Days: { ...empty, ...last7Days },
	}
}

test('usage drill-in stays on the org page and encodes the focused connection', () => {
	expect(accountConnectionsUsageHref('/account/agents')).toBe(
		'/account/agents/usage',
	)
	expect(
		accountConnectionsUsageHref('/@acme/-/agents', 'mcp-oauth:p1:client/a'),
	).toBe('/@acme/-/agents/usage?connection=mcp-oauth%3Ap1%3Aclient%2Fa')
})

test('quantities pluralize on the rounded value', () => {
	expect(formatConnectionUsageQuantity('executeCalls', 1)).toBe(
		'1 execute call',
	)
	expect(formatConnectionUsageQuantity('workerLoads', 4020.4)).toBe(
		'4,020 worker loads',
	)
})

test('other counts surface runs-only activity the cap column would hide', () => {
	expect(connectionUsageOtherCounts(totals({ runs: 14 }), 'executeCalls')).toBe(
		'14 runs',
	)
	expect(
		connectionUsageOtherCounts(
			totals({ executeCalls: 4020, workerLoads: 3 }),
			'workerLoads',
		),
	).toBe('4,020 execute calls')
	expect(connectionUsageOtherCounts(totals({}), 'executeCalls')).toBe('')
	expect(connectionUsageHasActivity(totals({ runs: 1 }))).toBe(true)
	expect(connectionUsageHasActivity(totals({}))).toBe(false)
})

test('entry labels reuse agent names and fall back for revoked credentials', () => {
	const agents = [{ clientId: 'client-a', label: 'Cursor' }]
	expect(
		connectionUsageEntryLabel(
			{ credentialKind: 'mcp-oauth', credentialId: 'client-a', label: null },
			agents,
		),
	).toBe('Cursor')
	expect(
		connectionUsageEntryLabel(
			{ credentialKind: 'api-token', credentialId: 'tok', label: '  ' },
			agents,
		),
	).toBe('Deleted API token')
	expect(
		connectionUsageEntryLabel(
			{ credentialKind: 'cli', credentialId: '', label: null },
			agents,
		),
	).toBe('Kody CLI (kody login)')
})
