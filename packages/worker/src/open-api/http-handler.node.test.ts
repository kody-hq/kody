import { afterEach, expect, test, vi } from 'vitest'
import * as integrationAuthorization from '#mcp/capabilities/integrations/authorize-integration.ts'
import * as integrationService from '#worker/integrations/service.ts'
import {
	mintApiToken,
	apiTokenLifetimeAliases,
} from '#worker/api-tokens/service.ts'
import {
	createOpenApiTestHarness as createApi,
	openApiTestAppOrigin as appOrigin,
} from '#worker/test-support/open-api-http.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

test('revalidates the OpenAPI document by content hash with If-None-Match', async () => {
	const api = await createApi()
	const first = await api.call('GET', '/openapi.json')
	const etag = first.headers.get('ETag')
	expect(etag).not.toBeNull()
	const again = await api.call('GET', '/openapi.json')
	expect(again.headers.get('ETag')).toBe(etag)

	const unchanged = await api.call('GET', '/openapi.json', {
		headers: { 'If-None-Match': `"stale", ${etag}` },
	})
	expect(unchanged.status).toBe(304)
	expect(unchanged.body).toBeNull()
	expect(unchanged.headers.get('ETag')).toBe(etag)
	expect(unchanged.headers.get('Cache-Control')).toBe('public, max-age=300')

	const changed = await api.call('GET', '/openapi.json', {
		headers: { 'If-None-Match': '"stale"' },
	})
	expect(changed.status).toBe(200)
	expect(changed.body['openapi']).toBe('3.1.0')

	// Opaque tags may contain commas; a substring that looks like our ETag
	// inside a different quoted validator must not 304.
	const embedded = await api.call('GET', '/openapi.json', {
		headers: { 'If-None-Match': `"prefix,${etag?.slice(1, -1)},suffix"` },
	})
	expect(embedded.status).toBe(200)

	const weak = await api.call('GET', '/openapi.json', {
		headers: { 'If-None-Match': `W/${etag}` },
	})
	expect(weak.status).toBe(304)
})

test('rejects missing, invalid, and revoked tokens with 401', async () => {
	const api = await createApi()
	const missing = await api.call('GET', '/v1/me')
	expect(missing.status).toBe(401)
	expect(missing.headers.get('WWW-Authenticate')).toBe(
		'Bearer realm="kody-api"',
	)
	expect(missing.body.error?.code).toBe('unauthorized')

	const token = await api.mint(['org:read'])
	const tampered = `${token.slice(0, -4)}AAAA`
	const invalid = await api.call('GET', '/v1/me', { token: tampered })
	expect(invalid.status).toBe(401)
	expect(invalid.headers.get('WWW-Authenticate')).toContain(
		'error="invalid_token"',
	)
	expect(JSON.stringify(invalid.body)).not.toContain(tampered)

	const revoke = await api.call('DELETE', '/v1/tokens/current', { token })
	expect(revoke.status).toBe(200)
	expect(revoke.body).toMatchObject({ revoked: true })
	const afterRevoke = await api.call('GET', '/v1/me', { token })
	expect(afterRevoke.status).toBe(401)
	expect(afterRevoke.body.error?.message).toMatch(/revoked/)
})

test('runs capability operations under the token scope and slides expiry', async () => {
	const api = await createApi()
	const token = await api.mint(['org:read'])
	const me = await api.call('GET', '/v1/me', { token })
	expect(me.status).toBe(200)
	expect(JSON.stringify(me.body)).toContain('api-user@example.com')

	const current = await api.call('GET', '/v1/tokens/current', { token })
	expect(current.status).toBe(200)
	expect(current.body).toMatchObject({
		scopes: ['org:read'],
		status: 'active',
	})
	expect(current.body['last_used_at']).toEqual(expect.any(String))
	expect(current.body).not.toHaveProperty('token')

	const denied = await api.call('GET', '/v1/secrets', { token })
	expect(denied.status).toBe(403)
	expect(denied.body['error']).toMatchObject({
		code: 'insufficient_scope',
		details: { required_permission: 'secret:use' },
	})

	const usage = api.sqlite
		.prepare(
			`SELECT event_count, error_count FROM usage_rollups WHERE metric = 'api_call' AND user_id = ?`,
		)
		.get(api.userId)
	expect(usage).toEqual({ event_count: 2, error_count: 0 })
})

test('writes secrets through path params and never returns the value', async () => {
	const api = await createApi()
	const token = await api.mint(['secret:use', 'secret:write', 'secret:create'])
	const saved = await api.call('PUT', '/v1/secrets/user/api-test-secret', {
		token,
		body: { value: 'super-secret-value', description: 'from the api' },
	})
	expect(saved.status).toBe(200)
	expect(JSON.stringify(saved.body)).not.toContain('super-secret-value')

	const listed = await api.call('GET', '/v1/secrets?scope=user', { token })
	expect(listed.status).toBe(200)
	expect(JSON.stringify(listed.body)).toContain('api-test-secret')
	expect(JSON.stringify(listed.body)).not.toContain('super-secret-value')

	const conflict = await api.call('PUT', '/v1/secrets/user/api-test-secret', {
		token,
		body: { name: 'other', value: 'x' },
	})
	expect(conflict.status).toBe(400)

	const wrongType = await api.call('PUT', '/v1/secrets/user/x', {
		token,
		body: 'value=x',
		contentType: 'text/plain',
	})
	expect(wrongType.status).toBe(415)
})

test('forwards deprecated integration locks with the legacy body and deprecation headers', async () => {
	const api = await createApi()
	const token = await api.mint(['integration:use'])
	const authorizeIntegration = vi
		.spyOn(integrationAuthorization, 'authorizeIntegration')
		.mockResolvedValue(undefined)
	const lockIntegrationToPackage = vi
		.spyOn(integrationService, 'lockIntegrationToPackage')
		.mockResolvedValue({
			name: 'google',
			allowedPackageIds: ['pkg-123'],
		} as never)
	const response = await api.call('POST', '/v1/integrations/google/lock', {
		token,
		body: { kind: 'secret', package_id: 'pkg-123' },
	})

	expect(response.status).toBe(200)
	expect(authorizeIntegration).toHaveBeenCalledWith(
		expect.anything(),
		'integration:use',
		'google',
	)
	expect(lockIntegrationToPackage).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'google', packageId: 'pkg-123' }),
	)
	expect(response.body).toMatchObject({
		name: 'google',
		usage_mode: 'packages',
		allowed_package_ids: ['pkg-123'],
		usage_url: expect.any(String),
	})
	expect(Object.keys(response.body).sort()).toEqual(
		['name', 'usage_mode', 'allowed_package_ids', 'usage_url'].sort(),
	)
	expect(response.body).not.toHaveProperty('kind')
	expect(response.headers.get('Deprecation')).toBe('@1792800000')
	expect(response.headers.get('Sunset')).toBe('Fri, 22 Jan 2027 00:00:00 GMT')
	expect(response.headers.get('Link')).toBe(
		'<https://kody.codes/docs/api-versioning.md>; rel="deprecation"',
	)
})

test('rejects deprecated integration locks without integration:use before dispatch', async () => {
	const api = await createApi()
	const lockIntegrationToPackage = vi
		.spyOn(integrationService, 'lockIntegrationToPackage')
		.mockResolvedValue({
			name: 'google',
			allowedPackageIds: ['pkg-123'],
		} as never)
	const response = await api.call('POST', '/v1/integrations/google/lock', {
		token: await api.mint(['secret:use']),
		body: { package_id: 'pkg-123' },
	})

	expect(response.status).toBe(403)
	expect(response.body['error']).toMatchObject({
		code: 'insufficient_scope',
		details: { required_permission: 'integration:use' },
	})
	expect(lockIntegrationToPackage).not.toHaveBeenCalled()
})

test('token minting enforces parent scopes for local-execute', async () => {
	const api = await createApi()
	const parent = await api.mint(['token:delete', 'token:read', 'package:read'])
	const child = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: {
			name: 'child',
			scopes: ['package:read'],
			lifetime: 'short',
			idle_ttl_seconds: 300,
			max_lifetime_seconds: 600,
		},
	})
	expect(child.status).toBe(400)

	const childOk = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: {
			name: 'child',
			scopes: ['package:read'],
			idle_ttl_seconds: 300,
			max_lifetime_seconds: 600,
		},
	})
	expect(childOk.status).toBe(200)
	expect(childOk.body).toMatchObject({
		scopes: ['package:read'],
		idle_ttl_seconds: 300,
		token_type: 'Bearer',
		created_via: 'api',
	})
	expect(childOk.body['token']).toMatch(/^kody_at_/)

	const missingLifetime = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'no-life', scopes: ['package:read'] },
	})
	expect(missingLifetime.status).toBe(400)
	expect(missingLifetime.body.error?.message).toMatch(
		/Token lifetime is required/,
	)

	const escalate = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'escalate', scopes: ['secret:use'], lifetime: 'short' },
	})
	expect(escalate.status).toBe(400)

	const missingParentScope = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'local', scopes: ['org:execute'], lifetime: 'short' },
	})
	expect(missingParentScope.status).toBe(400)

	const listed = await api.call('GET', '/v1/tokens', { token: parent })
	expect(listed.status).toBe(200)
	expect(listed.body['tokens']).toHaveLength(2)
	expect(JSON.stringify(listed.body)).not.toContain(childOk.body['token'])

	const noTokenRead = await api.mint(['package:read'])
	const listDenied = await api.call('GET', '/v1/tokens', {
		token: noTokenRead,
	})
	expect(listDenied.status).toBe(403)
	expect(listDenied.body.error?.code).toMatch(/insufficient_scope|forbidden/)
})

test('a token can only rotate tokens it could have minted', async () => {
	const api = await createApi()
	const rotator = await api.mint(['token:delete', 'token:read'])
	const stronger = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'stronger',
		scopes: ['secret:use', 'secret:write'],
		idleTtlSeconds: apiTokenLifetimeAliases.short.idleTtlSeconds,
		maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
		createdVia: 'mcp-api',
	})
	const denied = await api.call('POST', `/v1/tokens/${stronger.id}/rotate`, {
		token: rotator,
	})
	expect(denied.status).toBe(403)
	expect(denied.body.error).toMatchObject({
		code: 'insufficient_scope',
		details: { missing_scopes: ['secret:use', 'secret:write'] },
	})
	expect(JSON.stringify(denied.body)).not.toMatch(/kody_at_/)
	const stillWorks = await api.call('GET', '/v1/secrets', {
		token: stronger.token,
	})
	expect(stillWorks.status).toBe(200)

	const longerLived = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'longer',
		scopes: ['token:delete'],
		idleTtlSeconds: apiTokenLifetimeAliases.short.idleTtlSeconds,
		maxLifetimeSeconds: 7 * 24 * 60 * 60,
		createdVia: 'mcp-api',
	})
	const outlives = await api.call(
		'POST',
		`/v1/tokens/${longerLived.id}/rotate`,
		{ token: rotator },
	)
	expect(outlives.status).toBe(403)
	expect(outlives.body.error?.message).toMatch(/outlives/)

	const peer = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'peer',
		scopes: ['token:read'],
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 60 * 60,
		createdVia: 'api',
	})
	const allowed = await api.call('POST', `/v1/tokens/${peer.id}/rotate`, {
		token: rotator,
	})
	expect(allowed.status).toBe(200)
	expect(allowed.body['token']).toMatch(/^kody_at_/)
})

test('reported expiry includes the slide from the current request', async () => {
	const api = await createApi()
	const idleTtlSeconds = apiTokenLifetimeAliases.short.idleTtlSeconds
	const minted = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'aged',
		scopes: ['org:read'],
		idleTtlSeconds,
		maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
		createdVia: 'api',
		now: new Date(Date.now() - 5 * 60 * 1000),
	})
	const before = Date.now()
	const current = await api.call('GET', '/v1/tokens/current', {
		token: minted.token,
	})
	expect(current.status).toBe(200)
	const reported = Date.parse(String(current.body['expires_at']))
	expect(reported).toBeGreaterThan(Date.parse(minted.expires_at))
	expect(reported).toBeGreaterThanOrEqual(before + idleTtlSeconds * 1000 - 1000)
	const stored = api.sqlite
		.prepare(`SELECT expires_at FROM api_tokens WHERE id = ?`)
		.get(minted.id) as { expires_at: string }
	expect(stored.expires_at).toBe(current.body['expires_at'])
})

test('local-execute tokens are mintable when the parent holds the scope', async () => {
	const api = await createApi()
	const parent = await mintWithLocalExecute(api)
	const minted = await api.call('POST', '/v1/tokens', {
		token: parent,
		body: { name: 'local', scopes: ['org:execute'], lifetime: 'short' },
	})
	expect(minted.status).toBe(200)
	expect(minted.body['scopes']).toEqual(['org:execute'])
})

async function mintWithLocalExecute(
	api: Awaited<ReturnType<typeof createApi>>,
) {
	const minted = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'parent',
		scopes: ['token:delete', 'org:execute'],
		idleTtlSeconds: apiTokenLifetimeAliases.short.idleTtlSeconds,
		maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
		createdVia: 'mcp-api',
	})
	return minted.token
}

test('capability proxy session matches the CLI preflight contract', async () => {
	const api = await createApi()
	const token = await mintWithLocalExecute(api)
	const session = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(session.status).toBe(200)
	expect(session.body).toMatchObject({
		scopes: ['org:execute', 'token:delete'],
		expiresAt: expect.any(String),
		maxExpiresAt: expect.any(String),
		user: { userId: api.userId, email: 'api-user@example.com' },
		features: expect.arrayContaining(['credential-call-map']),
	})

	const noScope = await api.call('GET', '/v1/capability-proxy/session', {
		token: await api.mint(['org:read']),
	})
	expect(noScope.status).toBe(403)
	expect(noScope.body.error?.code).toBe('insufficient_scope')

	const bad = await api.call('GET', '/v1/capability-proxy/session', {
		token: `${token.slice(0, -4)}AAAA`,
	})
	expect(bad.status).toBe(401)
})

test('capability proxy returns 400 for malformed bodies when authorized', async () => {
	const api = await createApi()
	const token = await mintWithLocalExecute(api)

	const response = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: '{not-json',
	})
	expect(response.status).toBe(400)
	expect(response.body.error?.code).toBe('invalid_request')
})

test('incorrect CapabilityProxy secrets do not attribute api_call usage to the owner', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ captureUsage: points })
	const token = await mintWithLocalExecute(api)
	const wrongSecret = `${token.slice(0, -4)}AAAA`

	const response = await api.call('GET', '/v1/capability-proxy/session', {
		token: wrongSecret,
	})
	expect(response.status).toBe(401)
	expect(
		points.filter(
			(point) =>
				point.blobs[1] === 'api_call' && point.indexes?.[0] === api.userId,
		),
	).toEqual([])
})

test('capability proxy records distinguishable observe-only api_call telemetry', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ captureUsage: points })
	const token = await mintWithLocalExecute(api)

	const session = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(session.status).toBe(200)

	const noScope = await api.call('GET', '/v1/capability-proxy/session', {
		token: await api.mint(['org:read']),
	})
	expect(noScope.status).toBe(403)
	expect(noScope.body.error?.code).toBe('insufficient_scope')

	await api.call('DELETE', '/v1/tokens/current', { token })
	const revoked = await api.call('GET', '/v1/capability-proxy/session', {
		token,
	})
	expect(revoked.status).toBe(401)

	const proxyCalls = points.filter(
		(point) =>
			point.blobs[1] === 'api_call' &&
			String(point.blobs[2] ?? '').startsWith('capabilityProxySession'),
	)
	expect(proxyCalls.map((point) => [point.blobs[2], point.blobs[3]])).toEqual([
		['capabilityProxySession', 'success'],
		['capabilityProxySession:insufficient_scope', 'error'],
		['capabilityProxySession:unauthorized', 'error'],
	])
	expect(proxyCalls.every((point) => point.indexes?.[0] === api.userId)).toBe(
		true,
	)
	expect(
		points.some(
			(point) =>
				point.blobs[1] === 'execute' || point.blobs[1] === 'dynamic_worker_day',
		),
	).toBe(false)
})

test('capability proxy checks a credentials call map before local code runs', async () => {
	const api = await createApi()
	const token = await mintWithLocalExecute(api)
	const noMap = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'credentialClientCheck'], args: [{}] },
	})
	expect(noMap.status).toBe(200)
	expect(noMap.body).toEqual({ result: { ok: true, value: { warnings: [] } } })
	const missingPick = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: {
			path: ['kody', 'credentialClientCheck'],
			args: [{}],
			credentials: { github: 'no-such-credential' },
		},
	})
	expect(missingPick.status).toBe(200)
	expect(missingPick.body).toMatchObject({
		result: { ok: false, error: { code: 'credential_not_found' } },
	})
	const badMap = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: {
			path: ['kody', 'credentialClientCheck'],
			args: [{}],
			credentials: { github: { name: 'x', scope: 'team' } },
		},
	})
	expect(badMap.status).toBe(400)
})

test('capability proxy runs kody:runtime calls and meters each hop', async () => {
	const api = await createApi()
	const token = await mintWithLocalExecute(api)
	const me = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(me.status).toBe(200)
	expect(me.body).toEqual({ result: expect.any(Object) })
	expect(JSON.stringify(me.body['result'])).toContain('api-user@example.com')

	const unknown = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'noSuchCapability'], args: [] },
	})
	expect(unknown.status).toBe(404)
	expect(unknown.body.error?.message).toContain('kody.noSuchCapability')

	for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
		const response = await api.call('POST', '/v1/capability-proxy/call', {
			token,
			body: { path: ['kody', inherited], args: [] },
		})
		expect(response.status).toBe(404)
	}

	const unknownRoot = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['fetch', 'raw'], args: [] },
	})
	expect(unknownRoot.status).toBe(404)

	const missingServer = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'mcp', 'home', 'lights_on'], args: [{}] },
	})
	expect(missingServer.status).toBe(404)
	expect(missingServer.body.error?.message).toContain('home')

	const extraKey = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [], extra: true },
	})
	expect(extraKey.status).toBe(400)

	const usage = api.sqlite
		.prepare(
			`SELECT event_count FROM usage_rollups WHERE metric = 'api_call' AND user_id = ?`,
		)
		.get(api.userId) as { event_count: number }
	expect(usage.event_count).toBe(8)
	const executeUsage = api.sqlite
		.prepare(
			`SELECT COUNT(*) AS count FROM usage_rollups WHERE metric IN ('execute', 'dynamic_worker_day') AND user_id = ?`,
		)
		.get(api.userId)
	expect(executeUsage).toEqual({ count: 0 })

	await api.call('DELETE', '/v1/tokens/current', { token })
	const revoked = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(revoked.status).toBe(401)
})

test('mirrors the /mcp account gates', async () => {
	const unverified = await createApi({ emailVerified: false })
	const unverifiedToken = await unverified.mint(['org:read'])
	const unverifiedResponse = await unverified.call('GET', '/v1/me', {
		token: unverifiedToken,
	})
	expect(unverifiedResponse.status).toBe(403)
	expect(unverifiedResponse.body.error?.code).toBe(
		'email_verification_required',
	)

	const suspended = await createApi({ suspended: true })
	const suspendedToken = await suspended.mint(['org:read'])
	const suspendedResponse = await suspended.call('GET', '/v1/me', {
		token: suspendedToken,
	})
	expect(suspendedResponse.status).toBe(403)
	expect(suspendedResponse.body.error?.code).toBe('account_suspended')

	const reset = await createApi()
	const resetToken = await reset.mint(['org:read'])
	reset.sqlite
		.prepare(`UPDATE users SET password_changed_at = ? WHERE id = 1`)
		.run(new Date(Date.now() + 1000).toISOString())
	const resetResponse = await reset.call('GET', '/v1/me', {
		token: resetToken,
	})
	expect(resetResponse.status).toBe(401)

	const deleting = await createApi()
	const deletingToken = await deleting.mint(['org:read'])
	deleting.sqlite
		.prepare(`UPDATE users SET deleting_at = ? WHERE id = 1`)
		.run(new Date().toISOString())
	const deletingResponse = await deleting.call('GET', '/v1/me', {
		token: deletingToken,
	})
	expect(deletingResponse.status).toBe(401)
})

test('local-execute package-graph requires scope and meters as api_call prep', async () => {
	const points: Array<{
		blobs: Array<string | null | undefined>
		indexes?: Array<string | null | undefined>
	}> = []
	const api = await createApi({ captureUsage: points })
	const token = await mintWithLocalExecute(api)

	const empty = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: `export default async function main() {
  return fetch('https://api.example.com', {
    headers: { authorization: 'Bearer {{secret:demoToken}}' },
  })
}`,
		},
	})
	expect(empty.status).toBe(200)
	expect(empty.body).toMatchObject({
		imports: [],
		warnings: [],
		packageBindings: {},
		packageIdsByImport: {},
		modules: [
			{
				name: '.__kody_virtual__/runtime.js',
				esModule: expect.stringMatching(
					/__kodyGatewayFetch[\s\S]*globalThis\.fetch\s*=/,
				),
			},
		],
	})

	const dynamic = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: `const m = await import('kody:@missing/pkg/export')
export default async () => m`,
		},
	})
	expect(dynamic.status).toBe(400)
	expect(dynamic.body.error?.code).toBe('unsupported_dynamic_package_import')

	const unresolved = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: `import x from 'kody:@missing/pkg/export'
export default async () => x`,
		},
	})
	expect(unresolved.status).toBe(400)
	expect(unresolved.body.error?.code).toBe('package_import_unresolved')

	const noScope = await api.call('POST', '/v1/local-execute/package-graph', {
		token: await api.mint(['org:read']),
		body: { code: 'export default async function main() { return 1 }' },
	})
	expect(noScope.status).toBe(403)
	expect(noScope.body.error?.code).toBe('insufficient_scope')

	const packageGraphCalls = points.filter(
		(point) =>
			point.blobs[1] === 'api_call' &&
			String(point.blobs[2] ?? '').startsWith('localExecutePackageGraph'),
	)
	expect(
		packageGraphCalls.map((point) => [point.blobs[2], point.blobs[3]]),
	).toEqual(
		expect.arrayContaining([
			['localExecutePackageGraph', 'success'],
			['localExecutePackageGraph:unsupported_dynamic_package_import', 'error'],
			['localExecutePackageGraph:package_import_unresolved', 'error'],
			['localExecutePackageGraph:insufficient_scope', 'error'],
		]),
	)
	expect(
		points.some(
			(point) =>
				point.blobs[1] === 'execute' || point.blobs[1] === 'dynamic_worker_day',
		),
	).toBe(false)
})

test('package-graph accepts code over the old 512k char cap and imports-only prep', async () => {
	const { maxLocalExecutePackageGraphCodeBytes } =
		await import('./local-execute-package-graph.ts')
	const api = await createApi()
	const token = await mintWithLocalExecute(api)

	// Former Zod `.max(512_000)` rejected TanStack / React worker bundles
	// (~1.2–1.7 MiB). Inline code may now approach the Open API JSON body cap
	// (minus JSON-wrapper headroom).
	const overLegacyCap = `${'//'.padEnd(512_001, 'x')}\nexport default async function main() { return 1 }\n`
	expect(overLegacyCap.length).toBeGreaterThan(512_000)
	expect(overLegacyCap.length).toBeLessThan(
		maxLocalExecutePackageGraphCodeBytes,
	)
	const large = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: { code: overLegacyCap },
	})
	expect(large.status).toBe(200)
	expect(large.body).toMatchObject({
		imports: [],
		modules: [{ name: '.__kody_virtual__/runtime.js' }],
	})

	// Same size class with a real `kody:@` import so resolution still runs.
	const largeUnresolved = await api.call(
		'POST',
		'/v1/local-execute/package-graph',
		{
			token,
			body: {
				code: `import x from 'kody:@missing/pkg/export'\n${'//'.padEnd(512_001, 'x')}\nexport default async () => x\n`,
			},
		},
	)
	expect(largeUnresolved.status).toBe(400)
	expect(largeUnresolved.body.error?.code).toBe('package_import_unresolved')

	// Large `kody dev` bundles: pass imports alone (origin synthesizes entry).
	const importsOnly = await api.call(
		'POST',
		'/v1/local-execute/package-graph',
		{
			token,
			body: { imports: [] },
		},
	)
	expect(importsOnly.status).toBe(200)
	expect(importsOnly.body).toMatchObject({
		imports: [],
		modules: [{ name: '.__kody_virtual__/runtime.js' }],
	})

	const unresolvedImportsOnly = await api.call(
		'POST',
		'/v1/local-execute/package-graph',
		{
			token,
			body: { imports: ['kody:@missing/pkg/export'] },
		},
	)
	expect(unresolvedImportsOnly.status).toBe(400)
	expect(unresolvedImportsOnly.body.error?.code).toBe(
		'package_import_unresolved',
	)

	const neither = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {},
	})
	expect(neither.status).toBe(400)
	expect(neither.body.error?.code).toBe('invalid_request')

	// Over the shared JSON body / code ceiling: stay under the HTTP body reader
	// (5 MiB) so the handler's size assert runs. Message must name actual size
	// and limit — not a bare "Invalid parameters."
	const [{ packageGraphCodeTooLargeMessage }, { maxApiRequestBodyBytes }] =
		await Promise.all([
			import('./local-execute-package-graph.ts'),
			import('./request-params.ts'),
		])
	const overCeilingBytes = maxLocalExecutePackageGraphCodeBytes + 1
	const overCeiling = await api.call(
		'POST',
		'/v1/local-execute/package-graph',
		{
			token,
			body: { code: 'x'.repeat(overCeilingBytes) },
		},
	)
	expect(overCeiling.status).toBe(400)
	expect(overCeiling.body.error?.code).toBe('invalid_request')
	expect(overCeiling.body.error?.message).toBe(
		packageGraphCodeTooLargeMessage(overCeilingBytes),
	)
	expect(overCeiling.body.error?.message).toMatch(
		new RegExp(
			`code is ${overCeilingBytes} UTF-8 bytes; the maximum is ${maxLocalExecutePackageGraphCodeBytes}`,
		),
	)
	expect(overCeiling.body.error?.message).not.toBe('Invalid parameters.')

	// Multibyte source under the character maxLength can still blow the UTF-8
	// byte budget. Keep the JSON body under 5 MiB so the handler assert runs
	// (not the generic payload_too_large path).
	const euroCount = Math.floor(maxLocalExecutePackageGraphCodeBytes / 3) + 1
	const multibyteNearCeiling = '€'.repeat(euroCount)
	const multibyteBytes = new TextEncoder().encode(
		multibyteNearCeiling,
	).byteLength
	expect(multibyteNearCeiling.length).toBeLessThanOrEqual(
		maxLocalExecutePackageGraphCodeBytes,
	)
	expect(multibyteBytes).toBeGreaterThan(maxLocalExecutePackageGraphCodeBytes)
	expect(multibyteBytes).toBeLessThan(maxApiRequestBodyBytes)
	const multibyte = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: { code: multibyteNearCeiling },
	})
	expect(multibyte.status).toBe(400)
	expect(multibyte.body.error?.code).toBe('invalid_request')
	expect(multibyte.body.error?.message).toBe(
		packageGraphCodeTooLargeMessage(multibyteBytes),
	)
	expect(multibyte.body.error?.message).not.toBe('Invalid parameters.')
})

test('MCP OAuth Bearer authenticates CapabilityProxy and package-graph', async () => {
	const oauthToken = 'cli-oauth-access-token-not-kody-at'
	const api = await createApi({
		oauthAccessToken: oauthToken,
		oauthAudience: `${appOrigin}/mcp`,
	})

	const session = await api.call('GET', '/v1/capability-proxy/session', {
		token: oauthToken,
	})
	expect(session.status).toBe(200)
	expect(session.body).toMatchObject({
		scopes: ['org:execute'],
		expiresAt: expect.any(String),
		maxExpiresAt: expect.any(String),
		idleTtlSeconds: expect.any(Number),
		user: { userId: api.userId, email: 'api-user@example.com' },
		limits: {
			maxPathSegments: expect.any(Number),
			maxArgs: expect.any(Number),
			maxRequestBytes: expect.any(Number),
		},
	})

	const call = await api.call('POST', '/v1/capability-proxy/call', {
		token: oauthToken,
		body: { path: ['kody', 'metaGetCurrentUser'], args: [{}] },
	})
	expect(call.status).toBe(200)
	expect(JSON.stringify(call.body['result'])).toContain('api-user@example.com')

	const packageGraph = await api.call(
		'POST',
		'/v1/local-execute/package-graph',
		{
			token: oauthToken,
			body: {
				code: 'export default async function main() { return 1 }',
			},
		},
	)
	expect(packageGraph.status).toBe(200)
	expect(packageGraph.body.imports).toEqual([])
	expect(packageGraph.body.warnings).toEqual([])
	expect(packageGraph.body.modules).toEqual([
		expect.objectContaining({
			name: '.__kody_virtual__/runtime.js',
			esModule: expect.stringContaining('__kodyGatewayFetch'),
		}),
	])
})

test('MCP OAuth Bearer is rejected unless it is a valid CLI token on a local-execute route', async () => {
	const invalid = await createApi({
		oauthAccessToken: 'valid-oauth',
		oauthUnwrapFails: true,
	})
	const invalidResponse = await invalid.call(
		'GET',
		'/v1/capability-proxy/session',
		{ token: 'not-a-valid-oauth-or-api-token' },
	)
	expect(invalidResponse.status).toBe(401)
	expect(invalidResponse.body.error?.code).toBe('unauthorized')

	const oauthToken = 'cli-oauth-for-me-route'
	const localOnly = await createApi({
		oauthAccessToken: oauthToken,
	})
	for (const path of ['/v1/me', '/v1/tokens'] as const) {
		const response = await localOnly.call('GET', path, { token: oauthToken })
		expect(response.status).toBe(401)
		expect(response.body.error?.message).toBe('Invalid API token.')
	}

	const wrongAudience = await createApi({
		oauthAccessToken: 'cli-oauth-wrong-audience',
		oauthAudience: 'https://other.example/mcp',
	})
	expect(
		(
			await wrongAudience.call('GET', '/v1/capability-proxy/session', {
				token: 'cli-oauth-wrong-audience',
			})
		).status,
	).toBe(401)

	const nonCli = await createApi({
		oauthAccessToken: 'host-mcp-oauth-not-cli',
		oauthClientId: 'https://cursor.com/oauth/callback-client',
	})
	expect(
		(
			await nonCli.call('GET', '/v1/capability-proxy/session', {
				token: 'host-mcp-oauth-not-cli',
			})
		).status,
	).toBe(401)
})
