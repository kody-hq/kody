import { expect, test, vi } from 'vitest'
import {
	cloudflareStatusPageUrl,
	fetchRelevantProviderIncidents,
	filterRelevantProviderIncidents,
	parseProviderIncidentCache,
	parseProviderIncidentsPayload,
	providerIncidentCacheStaleMs,
	sanitizeProviderIncidentShortlink,
	serializeProviderIncidentCache,
	type ProviderIncident,
} from './provider-incidents.ts'

const r2Incident = {
	id: 'inc-r2',
	name: 'R2 Availability Issues',
	status: 'investigating',
	impact: 'minor',
	shortlink: 'https://stspg.io/r2',
	updated_at: '2026-08-07T19:00:00.000Z',
	components: [{ id: 'hb7g5sq2zz0h', name: 'R2' }],
	incident_updates: [
		{
			affected_components: [
				{
					code: 'hb7g5sq2zz0h',
					name: 'Cloudflare Sites and Services - R2',
				},
			],
		},
	],
}

const streamIncident = {
	id: 'inc-stream',
	name: 'Stream hiccup',
	status: 'identified',
	impact: 'major',
	shortlink: 'https://stspg.io/stream',
	updated_at: '2026-08-07T18:00:00.000Z',
	components: [{ id: 'stream-id', name: 'Stream' }],
}

const popIncident = {
	id: 'inc-pop',
	name: 'PoP degradation',
	status: 'monitoring',
	impact: 'minor',
	shortlink: 'https://stspg.io/pop',
	updated_at: '2026-08-07T17:00:00.000Z',
	components: [{ id: 'ams', name: 'Amsterdam, Netherlands - (AMS)' }],
}

function providerIncident(
	overrides: Partial<ProviderIncident> = {},
): ProviderIncident {
	return {
		id: 'inc-r2',
		name: 'R2 Availability Issues',
		status: 'investigating',
		impact: 'minor',
		shortlink: 'https://stspg.io/r2',
		updatedAt: '2026-08-07T19:00:00.000Z',
		affectedComponents: ['R2'],
		...overrides,
	}
}

test('filters Cloudflare incidents to products kody runs on', () => {
	const filtered = filterRelevantProviderIncidents([
		r2Incident,
		streamIncident,
		popIncident,
		{
			id: 'inc-workers',
			name: 'Workers elevated errors',
			status: 'identified',
			impact: 'major',
			shortlink: 'https://stspg.io/workers',
			updated_at: '2026-08-07T16:00:00.000Z',
			components: [],
			incident_updates: [
				{
					affected_components: [
						{ name: 'Cloudflare Sites and Services - Workers' },
						{ name: 'Cloudflare Sites and Services - Stream' },
					],
				},
			],
		},
	])
	expect(
		filtered.map(({ id, affectedComponents }) => [id, affectedComponents]),
	).toEqual([
		['inc-r2', ['R2']],
		['inc-workers', ['Workers']],
	])
	expect(
		parseProviderIncidentsPayload({ incidents: [streamIncident] }),
	).toEqual([])
})

test('provider incident fetch fails soft on timeout, http errors, and bad JSON', async () => {
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const fetchWith = (response: () => Promise<Response>, timeoutMs?: number) =>
		fetchRelevantProviderIncidents({ timeoutMs, fetcher: response })
	try {
		const timedOut = await fetchWith(() => new Promise(() => {}), 5)
		expect(timedOut.ok).toBe(false)
		expect(timedOut.incidents).toEqual([])
		await expect(
			fetchWith(async () => new Response('nope', { status: 503 })),
		).resolves.toEqual({ ok: false, incidents: [], error: 'HTTP 503' })
		const badJson = await fetchWith(
			async () =>
				new Response('not-json', {
					headers: { 'Content-Type': 'application/json' },
				}),
		)
		expect(badJson.ok).toBe(false)
		await expect(
			fetchWith(async () =>
				Response.json({ incidents: [streamIncident, popIncident] }),
			),
		).resolves.toEqual({ ok: true, incidents: [] })

		const okRelevant = await fetchWith(async () =>
			Response.json({ incidents: [r2Incident] }),
		)
		expect(okRelevant.ok).toBe(true)
		expect(okRelevant.incidents.map((incident) => incident.name)).toEqual([
			'R2 Availability Issues',
		])
		expect(consoleWarn).toHaveBeenCalled()
	} finally {
		consoleWarn.mockRestore()
	}
})

test('provider incident cache parses within TTL and rejects stale or corrupt entries', () => {
	const now = Date.UTC(2026, 7, 7, 20, 0, 0)
	const fresh = serializeProviderIncidentCache({
		fetchedAt: now - 30_000,
		incidents: [providerIncident()],
	})
	expect(parseProviderIncidentCache(fresh, now)?.[0]?.name).toBe(
		'R2 Availability Issues',
	)
	expect(
		parseProviderIncidentCache(fresh, now + providerIncidentCacheStaleMs + 1),
	).toBeNull()
	expect(parseProviderIncidentCache('not-json', now)).toBeNull()
	expect(parseProviderIncidentCache(null, now)).toBeNull()

	const incomplete = JSON.stringify({
		fetchedAt: now - 1_000,
		incidents: [
			{
				id: 'inc-partial',
				name: 'Missing fields',
				status: 'investigating',
				impact: 'minor',
				shortlink: 'https://stspg.io/x',
				// updatedAt / affectedComponents omitted on purpose
			},
		],
	})
	expect(parseProviderIncidentCache(incomplete, now)).toEqual([])

	const futureDated = serializeProviderIncidentCache({
		fetchedAt: now + 60_000,
		incidents: [providerIncident()],
	})
	expect(parseProviderIncidentCache(futureDated, now)).toBeNull()
})

test('provider shortlinks are restricted to Cloudflare Statuspage HTTPS hosts', () => {
	const cases = [
		['https://stspg.io/r2', 'https://stspg.io/r2'],
		['javascript:alert(1)', cloudflareStatusPageUrl],
		['https://evil.example/phish', cloudflareStatusPageUrl],
	]
	expect(
		cases.map(([shortlink]) => sanitizeProviderIncidentShortlink(shortlink!)),
	).toEqual(cases.map(([, expected]) => expected))
	expect(
		filterRelevantProviderIncidents([
			{ ...r2Incident, shortlink: 'javascript:alert(1)' },
		])[0]?.shortlink,
	).toBe(cloudflareStatusPageUrl)
})
