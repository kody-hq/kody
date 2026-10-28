import { expect, test } from 'vitest'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import {
	openApiExcludedCapabilities,
	openApiExcludedDomains,
} from './api-capability-surface.ts'
import { buildOpenApiDocument, resolveApiOperation } from './document.ts'
import {
	apiOperationUsesQueryInputs,
	apiOperations,
	capabilityNameForOperation,
	getApiOperationPathParams,
	listApiOperationPaths,
	matchApiRoute,
} from './operations.ts'

/**
 * Capabilities that are deliberately not on the Open API. Anything else in
 * an included domain must have an operation, so a new capability cannot
 * silently skip the API. Source of truth:
 * {@link openApiExcludedDomains} / {@link openApiExcludedCapabilities}.
 */
const excludedDomains = openApiExcludedDomains
const excludedCapabilities = openApiExcludedCapabilities

function schemaTypes(schema: unknown): Array<string> {
	if (!isRecord(schema)) return []
	const type = schema['type']
	const own =
		typeof type === 'string'
			? [type]
			: Array.isArray(type)
				? type.filter((entry): entry is string => typeof entry === 'string')
				: []
	const variants = [schema['anyOf'], schema['oneOf']].flatMap((value) =>
		Array.isArray(value) ? value.flatMap(schemaTypes) : [],
	)
	const enumTypes = Array.isArray(schema['enum'])
		? schema['enum'].map((value) => (value === null ? 'null' : typeof value))
		: []
	const constType =
		'const' in schema
			? [schema['const'] === null ? 'null' : typeof schema['const']]
			: []
	return [...own, ...variants, ...enumTypes, ...constType]
}

const scalarTypes = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function isQueryEncodable(schema: unknown) {
	const types = schemaTypes(schema)
	if (types.length === 0) return false
	return types.every((type) => {
		if (scalarTypes.has(type)) return true
		if (type !== 'array' || !isRecord(schema)) return false
		const items = schema['items']
		const itemTypes = schemaTypes(items)
		return (
			itemTypes.length > 0 && itemTypes.every((entry) => scalarTypes.has(entry))
		)
	})
}

test('operation ids and method+path pairs are unique', () => {
	const ids = apiOperations.map((operation) => operation.operationId)
	expect(new Set(ids).size).toBe(ids.length)
	const routes = apiOperations.flatMap((operation) =>
		listApiOperationPaths(operation).map(
			(path) => `${operation.method} ${path}`,
		),
	)
	expect(new Set(routes).size).toBe(routes.length)
	for (const operation of apiOperations) {
		expect(operation.path.startsWith('/v1/')).toBe(true)
		for (const path of listApiOperationPaths(operation)) {
			expect(path.startsWith('/v1/')).toBe(true)
		}
	}
})

test('every capability operation is a public, non-admin capability with matching inputs', async () => {
	const registry = await getStaticRegistry()
	const problems: Array<string> = []
	for (const operation of apiOperations) {
		const resolved = resolveApiOperation(operation, registry)
		if (operation.kind === 'capability') {
			const capability =
				registry.capabilityMap[capabilityNameForOperation(operation)]!
			if (excludedDomains.has(capability.domain)) {
				problems.push(`${operation.operationId}: excluded domain`)
			}
			if (capability.requiredRole || capability.requiredPermission) {
				problems.push(`${operation.operationId}: requires a role`)
			}
		}
		if (operation.method === 'GET' && !resolved.readOnly) {
			problems.push(`${operation.operationId}: GET must be read-only`)
		}
		const properties = isRecord(resolved.inputSchema['properties'])
			? resolved.inputSchema['properties']
			: {}
		const pathParams = getApiOperationPathParams(operation.path)
		for (const name of pathParams) {
			if (!(name in properties)) {
				problems.push(
					`${operation.operationId}: path param ${name} not an input`,
				)
			}
		}
		if (!apiOperationUsesQueryInputs(operation.method)) continue
		const omitted =
			operation.kind === 'capability' ? (operation.omitInputs ?? []) : []
		for (const [name, schema] of Object.entries(properties)) {
			if (pathParams.includes(name) || omitted.includes(name)) continue
			if (!isQueryEncodable(schema)) {
				problems.push(
					`${operation.operationId}: input ${name} cannot be a query param`,
				)
			}
		}
		const required = Array.isArray(resolved.inputSchema['required'])
			? (resolved.inputSchema['required'] as Array<string>)
			: []
		for (const name of omitted) {
			if (required.includes(name)) {
				problems.push(
					`${operation.operationId}: omitted input ${name} is required`,
				)
			}
		}
	}
	expect(problems).toEqual([])
})

test('every public capability in an API domain has an operation', async () => {
	const registry = await getStaticRegistry()
	const covered = new Set(
		apiOperations.map((operation) => operation.operationId),
	)
	const missing = registry.capabilityList
		.filter(
			(capability) =>
				!excludedDomains.has(capability.domain) &&
				!excludedCapabilities.has(capability.name) &&
				!capability.requiredRole &&
				!capability.requiredPermission,
		)
		.map((capability) => capability.name)
		.filter((name) => !covered.has(name))
	expect(missing).toEqual([])
})

test('every operation routes to itself, and static segments beat params', () => {
	for (const operation of apiOperations) {
		for (const template of listApiOperationPaths(operation)) {
			const path = template.replace(/\{([^}]+)\}/g, 'sample-$1')
			const match = matchApiRoute(operation.method, path)
			expect(match.kind === 'match' && match.operation.operationId).toBe(
				operation.operationId,
			)
		}
	}
	const current = matchApiRoute('GET', '/v1/tokens/current')
	expect(current.kind === 'match' && current.operation.operationId).toBe(
		'tokenGetCurrent',
	)
	const byId = matchApiRoute('GET', '/v1/tokens/abc')
	expect(byId).toMatchObject({
		kind: 'match',
		pathParams: { token_id: 'abc' },
	})
	const encoded = matchApiRoute('PUT', '/v1/secrets/user/my%20secret')
	expect(encoded).toMatchObject({
		kind: 'match',
		pathParams: { scope: 'user', name: 'my secret' },
	})
	expect(matchApiRoute('PATCH', '/v1/tokens')).toEqual({
		kind: 'method_not_allowed',
		allow: ['GET', 'POST'],
	})
	expect(matchApiRoute('GET', '/v1/nope')).toEqual({ kind: 'not_found' })

	const gitRemoteById = matchApiRoute(
		'POST',
		'/v1/repos/11111111-1111-4111-8111-111111111111/git-remote',
	)
	expect(gitRemoteById).toMatchObject({
		kind: 'match',
		pathParams: { repo_id: '11111111-1111-4111-8111-111111111111' },
	})
	expect(
		gitRemoteById.kind === 'match' && gitRemoteById.operation.operationId,
	).toBe('repoGetGitRemote')

	const gitRemoteByBody = matchApiRoute('POST', '/v1/repos/git-remote')
	expect(gitRemoteByBody).toMatchObject({
		kind: 'match',
		pathParams: {},
	})
	expect(
		gitRemoteByBody.kind === 'match' && gitRemoteByBody.operation.operationId,
	).toBe('repoGetGitRemote')
	// Static `/git-remote` beats `/{repo_id}/git-remote` if both could match.
	expect(
		gitRemoteByBody.kind === 'match' && gitRemoteByBody.pathParams,
	).toEqual({})

	const packageGitRemoteById = matchApiRoute(
		'POST',
		'/v1/packages/11111111-1111-4111-8111-111111111111/git-remote',
	)
	expect(packageGitRemoteById).toMatchObject({
		kind: 'match',
		pathParams: { package_id: '11111111-1111-4111-8111-111111111111' },
	})
	expect(
		packageGitRemoteById.kind === 'match' &&
			packageGitRemoteById.operation.operationId,
	).toBe('packageGetGitRemote')

	const packageGitRemoteByBody = matchApiRoute(
		'POST',
		'/v1/packages/git-remote',
	)
	expect(packageGitRemoteByBody).toMatchObject({
		kind: 'match',
		pathParams: {},
	})
	expect(
		packageGitRemoteByBody.kind === 'match' &&
			packageGitRemoteByBody.operation.operationId,
	).toBe('packageGetGitRemote')
	expect(
		packageGitRemoteByBody.kind === 'match' &&
			packageGitRemoteByBody.pathParams,
	).toEqual({})

	const packageExternalPushByBody = matchApiRoute(
		'POST',
		'/v1/packages/external-push',
	)
	expect(packageExternalPushByBody).toMatchObject({
		kind: 'match',
		pathParams: {},
	})
	expect(
		packageExternalPushByBody.kind === 'match' &&
			packageExternalPushByBody.operation.operationId,
	).toBe('packagePublishExternalPush')
})

test('the OpenAPI document covers every operation with resolvable refs', async () => {
	const document = await buildOpenApiDocument({
		serverUrl: 'https://api.kody.codes',
	})
	expect(document.openapi).toBe('3.1.0')
	expect(document.servers).toEqual([{ url: 'https://api.kody.codes' }])
	expect(document.externalDocs).toEqual({
		description: 'Interactive Kody API docs (Scalar)',
		url: 'https://api-docs.kody.codes',
	})
	expect(String(document.info['description'])).toContain(
		'https://api-docs.kody.codes',
	)
	expect(String(document.info['description'])).toContain(
		'https://kody.codes/docs/api-versioning.md',
	)
	expect(document.components.responses.Error).toBeDefined()
	expect(document.components.responses.RateLimited).toBeDefined()
	const sampleOp = document.paths['/v1/packages/{package_id}']?.['get']
	expect(sampleOp?.responses['400']).toEqual({
		$ref: '#/components/responses/Error',
	})
	expect(sampleOp?.responses['429']).toEqual({
		$ref: '#/components/responses/RateLimited',
	})
	expect(sampleOp?.responses.default).toEqual({
		$ref: '#/components/responses/Error',
	})

	const operationIds = Object.values(document.paths).flatMap((pathItem) =>
		Object.values(pathItem).map((operation) => operation.operationId),
	)
	// Emitted operationIds must be unique (aliases get `${id}ByPath`).
	expect(new Set(operationIds).size).toBe(operationIds.length)
	expect(operationIds).toEqual(
		expect.arrayContaining(
			apiOperations.map((operation) => operation.operationId),
		),
	)
	expect(operationIds.length).toBe(
		apiOperations.reduce(
			(count, operation) => count + listApiOperationPaths(operation).length,
			0,
		),
	)
	expect(document.paths['/v1/repos/git-remote']?.['post']?.operationId).toBe(
		'repoGetGitRemote',
	)
	expect(
		document.paths['/v1/repos/{repo_id}/git-remote']?.['post']?.operationId,
	).toBe('repoGetGitRemoteByPath')
	const bodyOnlyGitRemote = document.paths['/v1/repos/git-remote']?.['post']
	expect(bodyOnlyGitRemote).toBeDefined()
	const bodyOnlyPathParams = (bodyOnlyGitRemote?.parameters ?? []).filter(
		(parameter: { in: string }) => parameter.in === 'path',
	)
	expect(bodyOnlyPathParams).toEqual([])
	expect(
		bodyOnlyGitRemote?.requestBody?.content['application/json']?.schema,
	).toMatchObject({
		properties: expect.objectContaining({
			name: expect.anything(),
			repo_id: expect.anything(),
		}),
	})

	expect(document.paths['/v1/packages/git-remote']?.['post']?.operationId).toBe(
		'packageGetGitRemote',
	)
	expect(
		document.paths['/v1/packages/{package_id}/git-remote']?.['post']
			?.operationId,
	).toBe('packageGetGitRemoteByPath')
	const bodyOnlyPackageGitRemote =
		document.paths['/v1/packages/git-remote']?.['post']
	expect(bodyOnlyPackageGitRemote).toBeDefined()
	expect(
		(bodyOnlyPackageGitRemote?.parameters ?? []).filter(
			(parameter: { in: string }) => parameter.in === 'path',
		),
	).toEqual([])
	expect(
		bodyOnlyPackageGitRemote?.requestBody?.content['application/json']?.schema,
	).toMatchObject({
		properties: expect.objectContaining({
			name: expect.anything(),
			package_id: expect.anything(),
			create: expect.anything(),
		}),
	})
	expect(
		document.paths['/v1/packages/external-push']?.['post']?.requestBody
			?.content['application/json']?.schema,
	).toMatchObject({
		properties: expect.objectContaining({
			name: expect.anything(),
			package_id: expect.anything(),
		}),
	})
	expect(
		document.paths['/v1/packages/external-push']?.['post']?.operationId,
	).toBe('packagePublishExternalPush')
	expect(
		document.paths['/v1/packages/{package_id}/external-push']?.['post']
			?.operationId,
	).toBe('packagePublishExternalPushByPath')

	const serialized = JSON.stringify(document)
	expect(serialized).not.toContain('"$schema"')
	expect(serialized).not.toContain('#/$defs/')
	const components = document.components as Record<
		string,
		Record<string, unknown>
	>
	const danglingRefs = [...serialized.matchAll(/"\$ref":"([^"]+)"/g)]
		.map(([, ref]) => ref!)
		.filter((ref) => {
			const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(ref) ?? []
			return !(section && name && components[section]?.[name])
		})
	expect(danglingRefs).toEqual([])

	const pathParamMismatches: Array<string> = []
	const missingPermissions: Array<string> = []
	for (const [path, pathItem] of Object.entries(document.paths)) {
		for (const operation of Object.values(pathItem)) {
			const declared = (operation.parameters ?? [])
				.filter((parameter) => parameter.in === 'path')
				.map((parameter) => parameter.name)
				.sort()
			const expected = getApiOperationPathParams(path).sort()
			if (declared.join() !== expected.join()) {
				pathParamMismatches.push(String(operation.operationId))
			}
			expect(operation).not.toHaveProperty('x-kody-scope')
			const permission = operation['x-kody-permission']
			const valid =
				permission === 'none' ||
				(Array.isArray(permission)
					? permission.length > 1 && permission.every(isOrgPermission)
					: isOrgPermission(permission))
			if (!valid) {
				missingPermissions.push(String(operation.operationId))
			}
		}
	}
	expect(pathParamMismatches).toEqual([])
	expect(missingPermissions).toEqual([])
	expect(
		document.paths['/v1/packages/{package_id}']?.['get']?.['x-kody-permission'],
	).toBe('package:read')
	expect(
		document.paths['/v1/capability-proxy/call']?.['post']?.[
			'x-kody-permission'
		],
	).toBe('org:execute')
	const gatewayFetch =
		document.paths['/v1/capability-proxy/gateway-fetch']?.['post']
	expect(gatewayFetch?.['x-kody-permission']).toBe('org:execute')
	expect(gatewayFetch?.requestBody?.content['application/json']).toBeUndefined()
	expect(gatewayFetch?.requestBody?.content['*/*']?.schema).toEqual({
		type: 'string',
		format: 'binary',
	})
	expect(
		(gatewayFetch?.responses['200'] as { content?: Record<string, unknown> })
			?.content?.['application/json'],
	).toBeUndefined()
	expect(
		(gatewayFetch?.parameters ?? []).some(
			(parameter) =>
				parameter.in === 'header' &&
				parameter.name === 'X-Kody-Gateway-Url' &&
				parameter.required,
		),
	).toBe(true)

	const packageGraph =
		document.paths['/v1/local-execute/package-graph']?.['post']
	expect(packageGraph?.['x-kody-permission']).toBe('org:execute')
	expect(packageGraph?.requestBody?.required).toBe(true)
	const packageGraphSchema =
		packageGraph?.requestBody?.content['application/json']?.schema
	expect(
		Array.isArray(packageGraphSchema?.['anyOf']) ||
			Array.isArray(packageGraphSchema?.['oneOf']),
	).toBe(true)

	const tokenCreate = document.paths['/v1/tokens']?.['post']
	expect(tokenCreate?.['x-kody-permission']).toBe('none')
	expect(tokenCreate?.requestBody?.required).toBe(true)
	expect(document.paths['/v1/tokens']?.['get']?.['x-kody-permission']).toBe(
		'token:read',
	)
	expect(
		document.paths['/v1/tokens/{token_id}']?.['get']?.['x-kody-permission'],
	).toBe('token:read')
	expect(
		document.paths['/v1/tokens/{token_id}']?.['delete']?.['x-kody-permission'],
	).toBe('token:delete')
	expect(
		document.paths['/v1/tokens/{token_id}/rotate']?.['post']?.[
			'x-kody-permission'
		],
	).toBe('token:delete')
	const secretSet = document.paths['/v1/secrets/{scope}/{name}']?.['put']
	const secretBody = secretSet?.requestBody?.content['application/json']?.schema
	expect(
		Object.keys((secretBody?.['properties'] as object) ?? {}),
	).not.toContain('name')
	const resourceLock = document.paths['/v1/resource-locks']?.['post']
	expect(resourceLock?.['x-kody-permission']).toBe('none')
	const resourceLockSchema =
		resourceLock?.requestBody?.content['application/json']?.schema
	expect(
		Array.isArray(resourceLockSchema?.['oneOf']) ||
			Array.isArray(resourceLockSchema?.['anyOf']),
	).toBe(true)
	expect(resourceLock?.deprecated).toBeUndefined()
	const deprecatedLockRoutes = [
		{
			operationId: 'secretLock',
			path: '/v1/secrets/lock',
			pathParams: [],
			permission: 'secret:use',
		},
		{
			operationId: 'secretProviderLock',
			path: '/v1/secret-providers/{provider}/lock',
			pathParams: ['provider'],
			permission: 'secret:use',
		},
		{
			operationId: 'integrationLock',
			path: '/v1/integrations/{name}/lock',
			pathParams: ['name'],
			permission: 'integration:use',
		},
		{
			operationId: 'mcpServerLock',
			path: '/v1/mcp-servers/{server}/lock',
			pathParams: ['server'],
			permission: 'integration:use',
		},
	]
	for (const deprecatedRoute of deprecatedLockRoutes) {
		const operation = document.paths[deprecatedRoute.path]?.['post']
		expect(operation).toMatchObject({
			operationId: deprecatedRoute.operationId,
			deprecated: true,
		})
		expect(operation?.['x-kody-permission']).toBe(deprecatedRoute.permission)
		expect(operation?.description).toContain('resourceLock')
		const bodySchema =
			operation?.requestBody?.content['application/json']?.schema
		const bodyProperties = isRecord(bodySchema?.['properties'])
			? bodySchema['properties']
			: {}
		expect(bodyProperties).not.toHaveProperty('kind')
		expect(
			(operation?.parameters ?? [])
				.filter((parameter) => parameter.in === 'path')
				.map((parameter) => parameter.name),
		).toEqual(deprecatedRoute.pathParams)
	}
	expect(document.paths['/v1/search']?.['get']?.['x-kody-permission']).toBe(
		'search:read',
	)

	const gitRemoteBody =
		document.paths['/v1/packages/git-remote']?.['post']?.requestBody?.content[
			'application/json'
		]?.schema
	const gitRemoteProps = isRecord(gitRemoteBody?.['properties'])
		? gitRemoteBody['properties']
		: {}
	expect(isRecord(gitRemoteProps['kody_id'])).toBe(true)
	expect(
		(gitRemoteProps['kody_id'] as Record<string, unknown>)['deprecated'],
	).toBe(true)

	const enablementBody =
		document.paths['/v1/enablements']?.['post']?.requestBody?.content[
			'application/json'
		]?.schema
	const enablementProps = isRecord(enablementBody?.['properties'])
		? enablementBody['properties']
		: {}
	expect(isRecord(enablementProps['kodyId'])).toBe(true)
	expect(
		(enablementProps['kodyId'] as Record<string, unknown>)['deprecated'],
	).toBe(true)
})
