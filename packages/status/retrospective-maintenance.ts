/**
 * Secret-gated operator writes on resolved incidents: attach a retrospective,
 * or delete a health-check-only incident that had no user impact.
 * Lives on the status worker so origin / APP_DB being down cannot block it.
 */

import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import {
	parseIncidentRetrospectiveInput,
	stampIncidentRetrospective,
	type IncidentRetrospective,
} from './retrospective.ts'
import type { IncidentView } from './status-types.ts'

const incidentPathPrefix = '/__maintenance/incidents/'
const incidentRetrospectivePathSuffix = '/retrospective'
const incidentMaintenanceNotConfiguredMessage =
	'Status incident maintenance is not configured'

export type ResolvedIncidentWriteResult =
	| { ok: true; incident: IncidentView }
	| { ok: false; error: 'not-found' | 'not-resolved' }

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

function parseIncidentId(idPart: string): number | null {
	if (!/^\d+$/.test(idPart)) return null
	const id = Number(idPart)
	if (!Number.isInteger(id) || id < 1) return null
	return id
}

export function parseIncidentRetrospectivePath(
	pathname: string,
): number | null {
	if (
		!pathname.startsWith(incidentPathPrefix) ||
		!pathname.endsWith(incidentRetrospectivePathSuffix)
	) {
		return null
	}
	return parseIncidentId(
		pathname.slice(
			incidentPathPrefix.length,
			pathname.length - incidentRetrospectivePathSuffix.length,
		),
	)
}

export function parseIncidentPath(pathname: string): number | null {
	if (!pathname.startsWith(incidentPathPrefix)) return null
	return parseIncidentId(pathname.slice(incidentPathPrefix.length))
}

async function rejectUnauthorizedMaintenance(input: {
	request: Request
	method: 'POST' | 'DELETE'
	secret: string | null | undefined
}): Promise<Response | null> {
	if (input.request.method !== input.method) {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { Allow: input.method },
		})
	}

	const secret = input.secret?.trim()
	if (!secret) {
		return new Response(incidentMaintenanceNotConfiguredMessage, {
			status: 503,
		})
	}

	const bearer = readBearerToken(input.request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
		return new Response('Unauthorized', { status: 401 })
	}
	return null
}

function resolvedIncidentWriteResponse(
	result: ResolvedIncidentWriteResult,
	notResolvedMessage: string,
): Response {
	if (!result.ok) {
		const status = result.error === 'not-found' ? 404 : 409
		const error =
			result.error === 'not-found' ? 'incident not found' : notResolvedMessage
		return Response.json(
			{ ok: false, error },
			{ status, headers: { 'Cache-Control': 'no-store' } },
		)
	}
	return Response.json(
		{ ok: true, incident: result.incident },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

export async function handleIncidentRetrospectiveRequest(input: {
	request: Request
	incidentId: number
	secret: string | null | undefined
	now?: number
	setRetrospective: (
		id: number,
		retrospective: IncidentRetrospective,
	) => Promise<ResolvedIncidentWriteResult>
}): Promise<Response> {
	const rejected = await rejectUnauthorizedMaintenance({
		request: input.request,
		method: 'POST',
		secret: input.secret,
	})
	if (rejected) return rejected

	const body = await input.request.json().catch(() => null)
	const parsed = parseIncidentRetrospectiveInput(body)
	if (!parsed.ok) {
		return Response.json(
			{ ok: false, error: parsed.message },
			{ status: 400, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const retrospective = stampIncidentRetrospective(
		parsed.retrospective,
		input.now ?? Date.now(),
	)
	return resolvedIncidentWriteResponse(
		await input.setRetrospective(input.incidentId, retrospective),
		'retrospective requires a resolved incident',
	)
}

export async function handleIncidentDeleteRequest(input: {
	request: Request
	incidentId: number
	secret: string | null | undefined
	deleteIncident: (id: number) => Promise<ResolvedIncidentWriteResult>
}): Promise<Response> {
	const rejected = await rejectUnauthorizedMaintenance({
		request: input.request,
		method: 'DELETE',
		secret: input.secret,
	})
	if (rejected) return rejected

	return resolvedIncidentWriteResponse(
		await input.deleteIncident(input.incidentId),
		'only resolved incidents can be deleted',
	)
}

export function unknownStatusMaintenanceResponse(): Response {
	return Response.json(
		{ error: 'Unknown maintenance endpoint.' },
		{ status: 404, headers: { 'Cache-Control': 'no-store' } },
	)
}
