import { expect, test } from 'vitest'
import {
	handleIncidentDeleteRequest,
	handleIncidentRetrospectiveRequest,
	parseIncidentPath,
	parseIncidentRetrospectivePath,
	unknownStatusMaintenanceResponse,
} from './retrospective-maintenance.ts'
import type { IncidentRetrospective } from './retrospective.ts'
import type { IncidentView } from './status-types.ts'

function retrospectiveRequest(input: {
	method?: string
	authorization?: string | null
	body?: unknown
}) {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (input.authorization !== null) {
		headers.set('authorization', input.authorization ?? 'Bearer shared-secret')
	}
	return new Request(
		'https://status.kody.codes/__maintenance/incidents/10/retrospective',
		{
			method: input.method ?? 'POST',
			headers,
			body:
				input.method === 'GET'
					? undefined
					: JSON.stringify(
							input.body ?? {
								whatHappened: 'Probes failed twice.',
								impact: 'Jobs card went red.',
								timeline: [{ at: '2026-09-02T21:57:54.765Z', note: 'Opened.' }],
								cause: 'Unconfirmed.',
								whatWeDid: 'Probes recovered.',
								whatWeWillChange: 'Publish retrospectives.',
							},
						),
		},
	)
}

function incidentView(
	retrospective: IncidentRetrospective | null = null,
): IncidentView {
	return {
		id: 10,
		component: 'jobs',
		componentName: 'Jobs',
		startedAt: '2026-09-02T21:57:54.765Z',
		resolvedAt: '2026-09-02T22:00:51.866Z',
		detail: 'error',
		retrospective,
	}
}

test('retrospective maintenance path authenticates and writes only resolved incidents', async () => {
	expect(
		[
			'/__maintenance/incidents/10/retrospective',
			'/__maintenance/incidents/0/retrospective',
			'/__maintenance/status-incidents',
		].map(parseIncidentRetrospectivePath),
	).toEqual([10, null, null])
	expect(unknownStatusMaintenanceResponse().status).toBe(404)

	const rejected: Array<[Request, string, number]> = [
		[retrospectiveRequest({ method: 'GET' }), 'shared-secret', 405],
		[retrospectiveRequest({}), '  ', 503],
		[
			retrospectiveRequest({ authorization: 'Bearer wrong' }),
			'shared-secret',
			401,
		],
		[retrospectiveRequest({ authorization: null }), 'shared-secret', 401],
		[
			retrospectiveRequest({ body: { whatHappened: 'only' } }),
			'shared-secret',
			400,
		],
	]
	const responses = await Promise.all(
		rejected.map(([request, secret]) =>
			handleIncidentRetrospectiveRequest({
				request,
				incidentId: 10,
				secret,
				setRetrospective: async () => {
					throw new Error('should not write')
				},
			}),
		),
	)
	expect(responses.map((response) => response.status)).toEqual(
		rejected.map(([, , status]) => status),
	)
	expect(await responses.at(-1)!.json()).toMatchObject({ ok: false })

	const publishedAt = Date.parse('2026-09-02T22:20:00.000Z')
	let written: IncidentRetrospective | null = null
	const ok = await handleIncidentRetrospectiveRequest({
		request: retrospectiveRequest({}),
		incidentId: 10,
		secret: 'shared-secret',
		now: publishedAt,
		setRetrospective: async (id, retrospective) => {
			expect(id).toBe(10)
			written = retrospective
			return { ok: true, incident: incidentView(retrospective) }
		},
	})
	expect(ok.status).toBe(200)
	const okBody = (await ok.json()) as { ok: boolean; incident: IncidentView }
	expect(okBody.ok).toBe(true)
	expect(okBody.incident.retrospective?.publishedAt).toBe(
		'2026-09-02T22:20:00.000Z',
	)
	expect(written).toEqual({
		whatHappened: 'Probes failed twice.',
		impact: 'Jobs card went red.',
		timeline: [{ at: '2026-09-02T21:57:54.765Z', note: 'Opened.' }],
		cause: 'Unconfirmed.',
		whatWeDid: 'Probes recovered.',
		whatWeWillChange: 'Publish retrospectives.',
		publishedAt: '2026-09-02T22:20:00.000Z',
	})

	for (const [incidentId, error, status] of [
		[99, 'not-found', 404],
		[11, 'not-resolved', 409],
	] as const) {
		const response = await handleIncidentRetrospectiveRequest({
			request: retrospectiveRequest({}),
			incidentId,
			secret: 'shared-secret',
			setRetrospective: async () => ({ ok: false, error }),
		})
		expect(response.status).toBe(status)
	}
})

function deleteRequest(input: {
	method?: string
	authorization?: string | null
}) {
	const headers = new Headers()
	if (input.authorization !== null) {
		headers.set('authorization', input.authorization ?? 'Bearer shared-secret')
	}
	return new Request('https://status.kody.codes/__maintenance/incidents/11', {
		method: input.method ?? 'DELETE',
		headers,
	})
}

test('incident delete path authenticates and deletes only resolved incidents', async () => {
	expect(
		[
			'/__maintenance/incidents/11',
			'/__maintenance/incidents/0',
			'/__maintenance/incidents/11/retrospective',
			'/__maintenance/incidents/abc',
			'/__maintenance/incidents/',
		].map(parseIncidentPath),
	).toEqual([11, null, null, null, null])

	const rejected: Array<[Request, string, number]> = [
		[deleteRequest({ method: 'POST' }), 'shared-secret', 405],
		[deleteRequest({}), '  ', 503],
		[deleteRequest({ authorization: 'Bearer wrong' }), 'shared-secret', 401],
		[deleteRequest({ authorization: null }), 'shared-secret', 401],
	]
	const responses = await Promise.all(
		rejected.map(([request, secret]) =>
			handleIncidentDeleteRequest({
				request,
				incidentId: 11,
				secret,
				deleteIncident: async () => {
					throw new Error('should not delete')
				},
			}),
		),
	)
	expect(responses.map((response) => response.status)).toEqual(
		rejected.map(([, , status]) => status),
	)
	expect(responses[0]!.headers.get('Allow')).toBe('DELETE')

	const deleted: Array<number> = []
	const ok = await handleIncidentDeleteRequest({
		request: deleteRequest({}),
		incidentId: 11,
		secret: 'shared-secret',
		deleteIncident: async (id) => {
			deleted.push(id)
			return { ok: true, incident: { ...incidentView(), id } }
		},
	})
	expect(ok.status).toBe(200)
	expect(deleted).toEqual([11])
	expect(await ok.json()).toMatchObject({ ok: true, incident: { id: 11 } })

	for (const [error, status, message] of [
		['not-found', 404, 'incident not found'],
		['not-resolved', 409, 'only resolved incidents can be deleted'],
	] as const) {
		const response = await handleIncidentDeleteRequest({
			request: deleteRequest({}),
			incidentId: 11,
			secret: 'shared-secret',
			deleteIncident: async () => ({ ok: false, error }),
		})
		expect(response.status).toBe(status)
		expect(await response.json()).toEqual({ ok: false, error: message })
	}
})
