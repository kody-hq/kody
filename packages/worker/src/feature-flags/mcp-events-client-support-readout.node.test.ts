import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	buildMcpEventsClientSupportReadout,
	loadMcpEventsClientSupportReadout,
	type McpEventsClientSupportRow,
} from './mcp-events-client-support-readout.ts'

const row = (
	user_id: string,
	client_name: string,
	declared: number,
	events: number,
	subscribe: number,
): McpEventsClientSupportRow => ({
	user_id,
	client_name,
	declared_requests: declared,
	events_requests: events,
	subscribe_requests: String(subscribe),
})

test('clients that cannot use events count as not advertising, not as idle subscribers', () => {
	const readout = buildMcpEventsClientSupportReadout({
		windowStart: '2026-11-01T00:00:00.000Z',
		windowEnd: '2026-11-19T00:00:00.000Z',
		rows: [
			row('u-claude-code', 'claude-code', 0, 0, 0),
			row('u-codex', 'codex', 0, 0, 0),
			row('u-cursor', 'cursor', 0, 0, 0),
			row('u-declares', 'events-host', 4, 0, 0),
			row('u-openai', 'openai-mcp', 0, 3, 0),
			row('u-subscriber', 'events-host', 2, 5, 1),
			row('u-subscriber', 'cursor', 0, 0, 0),
			row('', 'anonymous', 1, 1, 1),
		],
	})
	expect(readout).toMatchObject({
		status: 'ok',
		users: 6,
		doesNotAdvertise: 3,
		advertisesNotSubscribed: 2,
		subscribed: 1,
	})
	if (readout.status !== 'ok') throw new Error('expected ok readout')
	expect(readout.clients).toEqual([
		{
			clientName: 'cursor',
			users: 2,
			doesNotAdvertise: 2,
			advertisesNotSubscribed: 0,
			subscribed: 0,
		},
		{
			clientName: 'events-host',
			users: 2,
			doesNotAdvertise: 0,
			advertisesNotSubscribed: 1,
			subscribed: 1,
		},
		{
			clientName: 'claude-code',
			users: 1,
			doesNotAdvertise: 1,
			advertisesNotSubscribed: 0,
			subscribed: 0,
		},
		{
			clientName: 'codex',
			users: 1,
			doesNotAdvertise: 1,
			advertisesNotSubscribed: 0,
			subscribed: 0,
		},
		{
			clientName: 'openai-mcp',
			users: 1,
			doesNotAdvertise: 0,
			advertisesNotSubscribed: 1,
			subscribed: 0,
		},
	])
})

test('loader queries MCP protocol events and degrades without Analytics Engine', async () => {
	await expect(loadMcpEventsClientSupportReadout({})).resolves.toMatchObject({
		status: 'unavailable',
	})

	const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
		Response.json({ data: [row('u-1', 'codex', 0, 0, 0)] }),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const env = {
			MCP_PROTOCOL_EVENTS: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		}
		const readout = await loadMcpEventsClientSupportReadout(
			env,
			new Date('2026-11-19T12:00:00.000Z'),
		)
		expect(readout).toMatchObject({
			status: 'ok',
			windowStart: '2026-11-01T00:00:00.000Z',
			users: 1,
			doesNotAdvertise: 1,
		})
		const query = String(fetchMock.mock.calls[0]?.[1]?.body)
		expect(query).toContain('FROM kody_mcp_protocol_events')
		expect(query).toContain("blob9 = 'declared'")
		expect(query).toContain("blob2 = 'events/subscribe'")

		consoleWarn.mockImplementation(() => {})
		fetchMock.mockImplementation(
			async () => new Response('nope', { status: 500 }),
		)
		await expect(loadMcpEventsClientSupportReadout(env)).resolves.toMatchObject(
			{ status: 'unavailable' },
		)
		expect(consoleWarn).toHaveBeenCalledWith(
			'mcp-events-client-support-readout-failed',
			expect.anything(),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})
