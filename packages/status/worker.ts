import { faviconIcoRedirectLocation } from './favicon.ts'
import {
	handleIncidentDeleteRequest,
	handleIncidentRetrospectiveRequest,
	parseIncidentPath,
	parseIncidentRetrospectivePath,
	unknownStatusMaintenanceResponse,
} from './retrospective-maintenance.ts'
import {
	renderMaintenancePage,
	renderStatusPage,
	renderStatusUnavailablePage,
} from './status-page.ts'
import { StatusStore, type StatusWorkerEnv } from './status-store.ts'
import type { ComponentStatus } from './status-types.ts'

export { StatusStore }

function getStore(env: StatusWorkerEnv) {
	return env.STATUS_STORE.get(env.STATUS_STORE.idFromName('singleton'))
}

async function handleMaintenance(
	request: Request,
	env: StatusWorkerEnv,
	pathname: string,
): Promise<Response> {
	const retrospectiveIncidentId = parseIncidentRetrospectivePath(pathname)
	if (retrospectiveIncidentId !== null) {
		const store = getStore(env)
		return handleIncidentRetrospectiveRequest({
			request,
			incidentId: retrospectiveIncidentId,
			secret: env.STATUS_INCIDENT_EVENT_SECRET,
			setRetrospective: (id, retrospective) =>
				store.setIncidentRetrospective(id, retrospective),
		})
	}
	const incidentId = parseIncidentPath(pathname)
	if (incidentId !== null) {
		const store = getStore(env)
		return handleIncidentDeleteRequest({
			request,
			incidentId,
			secret: env.STATUS_INCIDENT_EVENT_SECRET,
			deleteIncident: (id) => store.deleteIncident(id),
		})
	}
	return unknownStatusMaintenanceResponse()
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url)
		if (url.pathname.startsWith('/__maintenance/')) {
			return handleMaintenance(request, env, url.pathname)
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		if (url.pathname === '/maintenance') {
			return new Response(renderMaintenancePage(), {
				status: 200,
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'no-store',
				},
			})
		}
		if (url.pathname === '/health') {
			return Response.json(
				{ ok: true, commit: env.BUILD_COMMIT ?? null },
				{ headers: { 'Cache-Control': 'no-store' } },
			)
		}
		if (url.pathname === '/favicon.ico') {
			let status: ComponentStatus = 'unknown'
			try {
				status = (await getStore(env).getSnapshot()).overallStatus
			} catch (error) {
				console.warn(
					'status-favicon-snapshot-failed',
					error instanceof Error ? error.message : String(error),
				)
			}
			return new Response(null, {
				status: 302,
				headers: {
					Location: faviconIcoRedirectLocation(request.url, status),
					'Cache-Control': 'public, max-age=30',
				},
			})
		}
		if (url.pathname === '/' || url.pathname === '/status.json') {
			// The page must degrade gracefully even when its own Durable Object
			// is unavailable; a controlled 503 beats an uncaught error page.
			let snapshot
			try {
				snapshot = await getStore(env).getSnapshot()
			} catch (error) {
				console.warn(
					'status-snapshot-failed',
					error instanceof Error ? error.message : String(error),
				)
				const body = { error: 'Status data is temporarily unavailable.' }
				if (url.pathname === '/status.json') {
					return Response.json(body, {
						status: 503,
						headers: { 'Cache-Control': 'no-store' },
					})
				}
				return new Response(renderStatusUnavailablePage(body.error), {
					status: 503,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': 'no-store',
					},
				})
			}
			if (url.pathname === '/status.json') {
				return Response.json(snapshot, {
					headers: { 'Cache-Control': 'public, max-age=30' },
				})
			}
			return new Response(renderStatusPage(snapshot), {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'public, max-age=30',
				},
			})
		}
		return new Response('Not found', { status: 404 })
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(getStore(env).runProbes())
	},
} satisfies ExportedHandler<StatusWorkerEnv>
