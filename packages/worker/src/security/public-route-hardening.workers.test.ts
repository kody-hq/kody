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

test('protocol routing rejects retired connectors and protects maintenance endpoints', async () => {
	await env.APP_DB.prepare(`DROP TABLE IF EXISTS users`).run()
	await env.APP_DB.prepare(
		`CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			stable_user_id TEXT NOT NULL,
			personal_org_id TEXT
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (
				'connector-user',
				'connector-user@example.com',
				'hash',
				'connector-user-stable-id'
			)`,
	).run()

	const jsonPost = (body: unknown) => ({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const retiredConnectorRequests = [
		createRequest('/@connector-user/connectors/home/snapshot'),
		createRequest('/@connector-user/connectors/home/rpc/tools-list', {
			method: 'POST',
		}),
		createRequest(
			'/@connector-user/connectors/home/rpc/tools-call',
			jsonPost({ name: 'test', arguments: {} }),
		),
		createRequest(
			'/@connector-user/connectors/home/rpc/jsonrpc',
			jsonPost({ message: { jsonrpc: '2.0', method: 'ping', id: 1 } }),
		),
		createRequest('/@connector-user/connectors/home', {
			headers: { Upgrade: 'websocket' },
		}),
		createRequest('/connectors/home'),
	]
	for (const request of retiredConnectorRequests) {
		expect((await workerFetch(request)).status).toBe(404)
	}

	// Real maintenance routes from index.ts share handleSecretMaintenanceRequest:
	// non-POST → 405 (proves registration vs unknown JSON 404); unauthenticated
	// POST → 401 when the secret is set, otherwise 503 not-configured.
	const registeredMaintenanceRoutes: Array<
		[path: string, secret: string | undefined, notConfigured: string | null]
	> = [
		[
			'reindex-capabilities',
			env.CAPABILITY_REINDEX_SECRET,
			'Capability reindex is not configured',
		],
		[
			'execute-smoke',
			env.CAPABILITY_REINDEX_SECRET,
			'Origin-only execute smoke check is not configured',
		],
		[
			'reindex-memories',
			env.CAPABILITY_REINDEX_SECRET,
			'Memory reindex is not configured',
		],
		['reindex-jobs', env.JOB_REINDEX_SECRET, 'Job reindex is not configured'],
		['dr-restore', env.DR_RESTORE_SECRET, 'DR restore is not configured'],
		[
			'dr-export',
			env.DR_RESTORE_SECRET,
			'DR export maintenance is not configured',
		],
		// null: non-production is forbidden before the secret is consulted.
		['do-pitr', env.DR_RESTORE_SECRET, null],
		[
			'dr-mailbox-import',
			env.DR_RESTORE_SECRET,
			'Mailbox import is not configured',
		],
		[
			'status-incidents',
			env.STATUS_INCIDENT_EVENT_SECRET,
			'Status incident events are not configured',
		],
		[
			'mcp-execute-health',
			env.STATUS_INCIDENT_EVENT_SECRET,
			'MCP execute health probe is not configured',
		],
	]

	for (const [name, secret, notConfigured] of registeredMaintenanceRoutes) {
		const path = `/__maintenance/${name}`
		const methodResponse = await workerFetch(createRequest(path))
		expect(methodResponse.status).toBe(405)
		await expect(methodResponse.text()).resolves.toBe('Method Not Allowed')

		const unauthorized = await workerFetch(
			createRequest(path, { method: 'POST' }),
		)
		const [status, body] =
			notConfigured === null
				? [403, 'Forbidden']
				: secret?.trim()
					? [401, 'Unauthorized']
					: [503, notConfigured]
		expect([unauthorized.status, await unauthorized.text()]).toEqual([
			status,
			body,
		])
	}

	const unknownMaintenanceResponse = await workerFetch(
		createRequest('/__maintenance/nonexistent'),
	)
	expect(unknownMaintenanceResponse.status).toBe(404)
	await expect(unknownMaintenanceResponse.json()).resolves.toEqual({
		error: 'Unknown maintenance endpoint.',
	})
}, 60_000)
