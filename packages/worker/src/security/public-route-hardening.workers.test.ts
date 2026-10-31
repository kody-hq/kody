import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'

function createRequest(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	return new Request(`https://test.kody.dev${path}`, options)
}

async function workerFetch(request: Request): Promise<Response> {
	return await exports.default.fetch(request)
}

test('maintenance endpoints are protected and unknown routes stay unavailable', async () => {
	const registeredMaintenanceRoutes: Array<
		[
			name: string,
			secret: string | undefined,
			forbiddenOutsideProduction?: boolean,
		]
	> = [
		['reindex-capabilities', env.CAPABILITY_REINDEX_SECRET],
		['execute-smoke', env.CAPABILITY_REINDEX_SECRET],
		['reindex-memories', env.CAPABILITY_REINDEX_SECRET],
		['reindex-jobs', env.JOB_REINDEX_SECRET],
		['dr-restore', env.DR_RESTORE_SECRET],
		['dr-export', env.DR_RESTORE_SECRET],
		['dr-paced-status', env.DR_RESTORE_SECRET],
		['do-pitr', env.DR_RESTORE_SECRET, true],
		['dr-mailbox-import', env.DR_RESTORE_SECRET],
		['status-incidents', env.STATUS_INCIDENT_EVENT_SECRET],
		['mcp-execute-health', env.STATUS_INCIDENT_EVENT_SECRET],
	]

	for (const [
		name,
		secret,
		forbiddenOutsideProduction,
	] of registeredMaintenanceRoutes) {
		const path = `/__maintenance/${name}`
		const allowsGet = name === 'dr-paced-status'
		const methodResponse = await workerFetch(createRequest(path))
		if (allowsGet) {
			const getStatus = secret?.trim() ? 401 : 503
			expect(methodResponse.status).toBe(getStatus)
		} else {
			expect(methodResponse.status).toBe(405)
		}

		const unauthorized = await workerFetch(
			createRequest(path, { method: 'POST' }),
		)
		const status = forbiddenOutsideProduction ? 403 : secret?.trim() ? 401 : 503
		expect(unauthorized.status).toBe(status)
	}

	const unknownMaintenanceResponse = await workerFetch(
		createRequest('/__maintenance/nonexistent'),
	)
	expect(unknownMaintenanceResponse.status).toBe(404)
}, 60_000)
