import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	currentStoredTokenLifetimeAlias,
	insufficientScopeMessage,
	readInsufficientScopeDetails,
} from './api-token.js'
import { apiTokenEnvVar, cliName, defaultApiUrl } from './defaults.js'
import {
	assertTokenSafeApiUrl,
	capabilityProxyUrl,
} from './capability-proxy.js'
import {
	formatUnreachableApiMessage,
	requestSentStatus,
	type RequestSentStatus,
} from './network-error.js'
import { bakedOpenApiRoutes } from './generated/openapi-routes.js'
import { type ToolCallResult } from './tool-result.js'
import { readPackageVersion } from './package-info.js'
import { userCacheDir } from './workerd-binary.js'

export type OpenApiClientInput = {
	apiUrl?: string
	token: string
	fetchFn?: typeof fetch
	/**
	 * User-owned API token org selection (ADR 0070). Appended as `?org=<slug>`
	 * on Open API requests. Ignored when unset (personal org default).
	 */
	org?: string
}

export class OpenApiError extends Error {
	readonly status: number | null
	readonly code: string | null
	/**
	 * Set when `fetch` rejected before an HTTP response. `false` = connect
	 * phase (nothing sent); `"unknown"` = body may have reached the server.
	 */
	readonly sent?: RequestSentStatus

	constructor(
		message: string,
		options: {
			status?: number | null
			code?: string | null
			sent?: RequestSentStatus
		} = {},
	) {
		super(message)
		this.name = 'OpenApiError'
		this.status = options.status ?? null
		this.code = options.code ?? null
		if (options.sent !== undefined) this.sent = options.sent
	}
}

/** Path to the live OpenAPI document on the Kody API origin. */
export const openApiDocumentPath = 'openapi.json'

/**
 * Bootstrap redeem returns a `kody_at_…` once. Agents must use
 * `kody auth bootstrap --code` so the token is stored and never printed.
 */
export const cliCredentialBootstrapRedeemOperationId =
	'cliCredentialBootstrapRedeem'

export type OpenApiOperationRoute = {
	operationId: string
	method: string
	pathTemplate: string
	pathParamNames: Array<string>
}

type OpenApiRouteCacheEntry = {
	/** The document's content hash from the `ETag` header; null when the server sent none. */
	etag: string | null
	operations: Map<string, OpenApiOperationRoute>
}

/** Per API origin, for the lifetime of the process. */
const openApiRouteCache = new Map<string, OpenApiRouteCacheEntry>()

/**
 * Parsed route maps persist under `<cache dir>/openapi/<sha256(etag)>.json`,
 * keyed by the document's content hash, with `<sha256(origin)>.etag` naming
 * the current hash per API origin. Every process revalidates once with
 * `If-None-Match`: 304 reuses the stored map without downloading the ~400KB
 * document, 200 replaces it. There is no time-based expiry.
 */
const openApiRouteCacheVersion = 1

function openApiCacheDir(): string {
	return join(userCacheDir(), 'openapi')
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

function originPointerPath(origin: string): string {
	return join(openApiCacheDir(), `${sha256Hex(origin)}.etag`)
}

function routeMapPath(etag: string): string {
	return join(openApiCacheDir(), `${sha256Hex(etag)}.json`)
}

function isOperationRoute(value: unknown): value is OpenApiOperationRoute {
	if (!value || typeof value !== 'object') return false
	const route = value as Record<string, unknown>
	return (
		typeof route.operationId === 'string' &&
		typeof route.method === 'string' &&
		typeof route.pathTemplate === 'string' &&
		Array.isArray(route.pathParamNames) &&
		route.pathParamNames.every((name) => typeof name === 'string')
	)
}

/** Unreadable, corrupt or mismatched files count as a miss and get replaced by the next 200. */
async function readPersistedRoutes(
	origin: string,
): Promise<OpenApiRouteCacheEntry | null> {
	try {
		const etag = (await readFile(originPointerPath(origin), 'utf8')).trim()
		if (!etag) return null
		const raw: unknown = JSON.parse(await readFile(routeMapPath(etag), 'utf8'))
		if (!raw || typeof raw !== 'object') return null
		const entry = raw as Record<string, unknown>
		if (entry.version !== openApiRouteCacheVersion || entry.etag !== etag)
			return null
		if (
			!Array.isArray(entry.operations) ||
			!entry.operations.every(isOperationRoute)
		)
			return null
		return {
			etag,
			operations: new Map(
				entry.operations.map((route) => [route.operationId, route]),
			),
		}
	} catch {
		return null
	}
}

/** Best effort: the response is already parsed, so a read-only cache dir must not fail the command. */
async function persistRoutes(
	origin: string,
	previousEtag: string | null,
	entry: OpenApiRouteCacheEntry,
): Promise<void> {
	if (!entry.etag) return
	try {
		await mkdir(openApiCacheDir(), { recursive: true })
		await writeFile(
			routeMapPath(entry.etag),
			JSON.stringify({
				version: openApiRouteCacheVersion,
				etag: entry.etag,
				operations: [...entry.operations.values()],
			}),
		)
		await writeFile(originPointerPath(origin), entry.etag)
		if (previousEtag && previousEtag !== entry.etag) {
			await rm(routeMapPath(previousEtag), { force: true })
		}
	} catch {
		// Cache writes are an optimization only.
	}
}

export async function openApiGet(
	input: OpenApiClientInput & {
		path: string
		query?: Record<string, string | number | undefined>
	},
): Promise<unknown> {
	return openApiRequest({
		...input,
		method: 'GET',
		path: input.path,
		query: input.query,
	})
}

/**
 * Authenticated Open API request (Bearer `kody_at_…`). Shared by search/whoami
 * helpers and `kody api <operationId>`.
 */
export async function openApiRequest(
	input: OpenApiClientInput & {
		method: string
		path: string
		query?: Record<string, unknown>
		body?: Record<string, unknown>
	},
): Promise<unknown> {
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const url = capabilityProxyUrl(apiUrl, input.path.replace(/^\//, ''))
	if (input.org) {
		url.searchParams.set('org', input.org)
	}
	if (input.query) {
		appendQueryParams(url.searchParams, input.query)
	}
	const method = input.method.toUpperCase()
	const headers: Record<string, string> = {
		accept: 'application/json',
		authorization: `Bearer ${input.token}`,
		'user-agent': `${cliName}/${readPackageVersion()}`,
	}
	let body: string | undefined
	if (input.body !== undefined && method !== 'GET' && method !== 'HEAD') {
		headers['content-type'] = 'application/json'
		body = JSON.stringify(input.body)
	}
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, { method, headers, body })
	} catch (error) {
		throw new OpenApiError(
			formatUnreachableApiMessage({ origin: url.origin, error }),
			{ sent: requestSentStatus(error) },
		)
	}
	const responseBody = await readJson(response)
	if (!response.ok) {
		throw describeOpenApiFailure(response.status, responseBody, url)
	}
	return responseBody
}

/**
 * Call one Open API operation by `operationId` + flat `params`, matching the
 * MCP `api` tool shape. Resolves method/path from `/openapi.json`.
 */
export async function callOpenApiOperation(
	input: OpenApiClientInput & {
		operationId: string
		params?: Record<string, unknown>
		/** Test seam: skip /openapi.json fetch. */
		operations?: Map<string, OpenApiOperationRoute>
	},
): Promise<unknown> {
	const operationId = input.operationId.trim()
	if (!operationId) {
		throw new OpenApiError(
			'Provide an Open API operationId (e.g. usageGet, metaGetCurrentUser).',
		)
	}
	assertApiOperationAllowed(operationId)
	const apiUrl = input.apiUrl || defaultApiUrl
	const operations =
		input.operations ??
		(await loadOpenApiOperations({ apiUrl, fetchFn: input.fetchFn }))
	const route = operations.get(operationId)
	if (!route) {
		throw new OpenApiError(
			`Unknown operationId "${operationId}". Operation ids are listed in ${capabilityProxyUrl(apiUrl, openApiDocumentPath).href} and match Kody capability names (plus token operations such as tokenCreate).`,
			{ status: 404, code: 'not_found' },
		)
	}
	const built = buildOpenApiHttpRequest({
		route,
		params: input.params ?? {},
	})
	return openApiRequest({
		token: input.token,
		apiUrl,
		fetchFn: input.fetchFn,
		...(input.org ? { org: input.org } : {}),
		method: built.method,
		path: built.path,
		query: built.query,
		body: built.body,
	})
}

export function assertApiOperationAllowed(operationId: string): void {
	if (operationId === cliCredentialBootstrapRedeemOperationId) {
		throw new OpenApiError(
			`Refusing to call ${cliCredentialBootstrapRedeemOperationId}: redeem returns a kody_at_… token that must not print to stdout. Use \`kody auth bootstrap --code <kody_bc_…>\` instead (stores the token; never prints it).`,
			{ status: null, code: 'refused' },
		)
	}
}

/**
 * Split flat MCP-style params into path / query / body for an Open API route.
 * GET and DELETE send non-path fields as query; other methods send them as JSON body.
 */
export function buildOpenApiHttpRequest(input: {
	route: OpenApiOperationRoute
	params: Record<string, unknown>
}): {
	method: string
	path: string
	query?: Record<string, unknown>
	body?: Record<string, unknown>
} {
	const remaining: Record<string, unknown> = { ...input.params }
	const pathParams: Record<string, string> = {}
	for (const name of input.route.pathParamNames) {
		if (
			!(name in remaining) ||
			remaining[name] === undefined ||
			remaining[name] === null
		) {
			throw new OpenApiError(
				`Missing required path parameter "${name}" for ${input.route.operationId} (${input.route.pathTemplate}).`,
			)
		}
		pathParams[name] = String(remaining[name])
		delete remaining[name]
	}
	const path = fillPathTemplate(input.route.pathTemplate, pathParams)
	const method = input.route.method.toUpperCase()
	if (apiOperationUsesQueryInputs(method)) {
		return {
			method,
			path,
			...(Object.keys(remaining).length > 0 ? { query: remaining } : {}),
		}
	}
	return {
		method,
		path,
		body: remaining,
	}
}

export function apiOperationUsesQueryInputs(method: string): boolean {
	const upper = method.toUpperCase()
	return upper === 'GET' || upper === 'DELETE'
}

export async function loadOpenApiOperations(input: {
	apiUrl?: string
	fetchFn?: typeof fetch
	/** Bypass cache (tests). */
	bustCache?: boolean
}): Promise<Map<string, OpenApiOperationRoute>> {
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const cacheKey = new URL(apiUrl).origin
	if (!input.bustCache) {
		const cached = openApiRouteCache.get(cacheKey)
		if (cached) return cached.operations
	}
	const persisted = input.bustCache ? null : await readPersistedRoutes(cacheKey)
	const url = capabilityProxyUrl(apiUrl, openApiDocumentPath)
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'GET',
			headers: {
				accept: 'application/json',
				'user-agent': `${cliName}/${readPackageVersion()}`,
				...(persisted?.etag ? { 'if-none-match': persisted.etag } : {}),
			},
		})
	} catch (error) {
		if (bakedOpenApiRoutes.length > 0) {
			// Do not cache the baked table: a later call in this process should
			// retry the network and pick up routes published after this CLI built.
			return new Map(
				bakedOpenApiRoutes.map((route) => [route.operationId, route]),
			)
		}
		throw new OpenApiError(
			formatUnreachableApiMessage({ origin: url.origin, error }).replace(
				`Could not reach the Kody API at ${url.origin}`,
				`Could not load OpenAPI from ${url.href}`,
			),
			{ sent: requestSentStatus(error) },
		)
	}
	if (response.status === 304 && persisted) {
		openApiRouteCache.set(cacheKey, persisted)
		return persisted.operations
	}
	const body = await readJson(response)
	if (!response.ok) {
		throw new OpenApiError(
			`Could not load OpenAPI from ${url.href} (HTTP ${response.status}).`,
			{ status: response.status },
		)
	}
	const entry = {
		etag: response.headers.get('etag'),
		operations: indexOpenApiOperations(body),
	}
	openApiRouteCache.set(cacheKey, entry)
	await persistRoutes(cacheKey, persisted?.etag ?? null, entry)
	return entry.operations
}

/** Visible for tests. */
export function indexOpenApiOperations(
	document: unknown,
): Map<string, OpenApiOperationRoute> {
	if (!isRecord(document) || !isRecord(document.paths)) {
		throw new OpenApiError('OpenAPI document is missing a paths object.')
	}
	const operations = new Map<string, OpenApiOperationRoute>()
	for (const [pathTemplate, methods] of Object.entries(document.paths)) {
		if (!isRecord(methods)) continue
		for (const [method, operation] of Object.entries(methods)) {
			if (!isRecord(operation)) continue
			const operationId =
				typeof operation.operationId === 'string' ? operation.operationId : ''
			if (!operationId) continue
			operations.set(operationId, {
				operationId,
				method: method.toUpperCase(),
				pathTemplate,
				pathParamNames: pathParamNamesFromTemplate(pathTemplate),
			})
		}
	}
	return operations
}

/** Clear the in-memory OpenAPI route cache (tests). */
export function clearOpenApiRouteCache(): void {
	openApiRouteCache.clear()
}

function pathParamNamesFromTemplate(pathTemplate: string): Array<string> {
	const names: Array<string> = []
	for (const match of pathTemplate.matchAll(/\{([^{}/]+)\}/g)) {
		const name = match[1]
		if (name) names.push(name)
	}
	return names
}

function fillPathTemplate(
	pathTemplate: string,
	pathParams: Record<string, string>,
): string {
	return pathTemplate.replace(/\{([^{}/]+)\}/g, (_full, name: string) => {
		const value = pathParams[name]
		if (value === undefined) {
			throw new OpenApiError(
				`Missing path parameter "${name}" for ${pathTemplate}.`,
			)
		}
		return encodeURIComponent(value)
	})
}

function appendQueryParams(
	searchParams: URLSearchParams,
	query: Record<string, unknown>,
): void {
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (entry === undefined || entry === null) continue
				searchParams.append(key, stringifyQueryValue(entry))
			}
			continue
		}
		searchParams.set(key, stringifyQueryValue(value))
	}
}

function stringifyQueryValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value)
	return JSON.stringify(value)
}

export async function searchWithApiToken(
	input: OpenApiClientInput & {
		query?: string
		domain?: string
		limit?: number
		entity?: string
	},
): Promise<ToolCallResult> {
	const body = await openApiRequest({
		token: input.token,
		...(input.apiUrl ? { apiUrl: input.apiUrl } : {}),
		...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
		...(input.org ? { org: input.org } : {}),
		method: 'POST',
		path: 'v1/search/tool',
		body: {
			...(input.query ? { query: input.query } : {}),
			...(input.domain ? { domain: input.domain } : {}),
			...(input.limit !== undefined ? { limit: input.limit } : {}),
			...(input.entity ? { entity: input.entity } : {}),
		},
	})
	return toolResultFromHttpBody(body)
}

export function toolResultFromHttpBody(payload: unknown): ToolCallResult {
	if (isRecord(payload) && Array.isArray(payload.content)) {
		return {
			content: payload.content as ToolCallResult['content'],
			structuredContent: payload.structuredContent,
			isError: payload.isError === true,
		}
	}
	const text =
		typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
	return {
		content: [{ type: 'text', text }],
		structuredContent: payload,
		isError: false,
	}
}

export async function whoamiWithApiToken(input: OpenApiClientInput): Promise<{
	mcpUrl?: undefined
	apiUrl: string
	token: {
		id: string
		name: string | null
		scopes: Array<string>
		expiresAt: string | null
		maxExpiresAt: string | null
	}
	user: { userId: string; email: string; displayName: string } | null
}> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const current = (await openApiGet({
		...input,
		apiUrl,
		path: 'v1/tokens/current',
	})) as Record<string, unknown>

	let user: { userId: string; email: string; displayName: string } | null = null
	try {
		const me = (await openApiGet({
			...input,
			apiUrl,
			path: 'v1/me',
		})) as Record<string, unknown>
		user = {
			userId: String(me.user_id ?? ''),
			email: String(me.email ?? ''),
			displayName: String(me.display_name ?? ''),
		}
	} catch (error) {
		// account:read is optional; tokens/current needs no scope.
		if (!(error instanceof OpenApiError && error.status === 403)) throw error
	}

	return {
		apiUrl,
		token: {
			id: String(current.id ?? ''),
			name: typeof current.name === 'string' ? current.name : null,
			scopes: Array.isArray(current.scopes)
				? current.scopes.filter(
						(scope): scope is string => typeof scope === 'string',
					)
				: [],
			expiresAt:
				typeof current.expires_at === 'string' ? current.expires_at : null,
			maxExpiresAt:
				typeof current.max_expires_at === 'string'
					? current.max_expires_at
					: null,
		},
		user,
	}
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function readErrorBody(
	body: unknown,
): { code: string | null; message: string } | null {
	if (!isRecord(body) || body.error == null) return null
	const { error } = body
	if (typeof error === 'string') return { code: null, message: error }
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : null
		const message =
			typeof error.message === 'string'
				? error.message
				: (code ?? JSON.stringify(error))
		return { code, message }
	}
	return { code: null, message: String(error) }
}

function describeOpenApiFailure(
	status: number,
	body: unknown,
	url: URL,
): OpenApiError {
	const failure = readErrorBody(body)
	const code = failure?.code ?? null
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	if (status === 401) {
		return new OpenApiError(
			`Kody rejected the API token (expired, revoked, or malformed). Mint a fresh scoped token and pass it with --token or ${apiTokenEnvVar}.${detail}`,
			{ status, code },
		)
	}
	if (status === 403 && code === 'insufficient_scope') {
		return new OpenApiError(
			`${insufficientScopeMessage({
				...readInsufficientScopeDetails(body),
				currentLifetime: currentStoredTokenLifetimeAlias(url.origin),
			})}${detail}`,
			{ status, code },
		)
	}
	if (code === 'feature_disabled') {
		return new OpenApiError(`Kody returned feature_disabled.${detail}`, {
			status,
			code,
		})
	}
	return new OpenApiError(
		failure?.message ??
			`Kody API request failed with HTTP ${status} (${url.pathname}).`,
		{ status, code },
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
