/**
 * MCP protocol lane metrics.
 *
 * `/mcp` serves two lanes: the sessionful Durable Object `McpAgent` lane for
 * 2025-era protocol revisions ("legacy") and the stateless SDK v2 lane for
 * 2026-07-28+ revisions ("modern"). The legacy lane can only be retired once
 * real traffic stops using it, so every authenticated `/mcp` request records
 * one data point describing which lane served it, the protocol revision, the
 * JSON-RPC method, and the connecting client.
 *
 * Data points go to the `MCP_PROTOCOL_EVENTS` Analytics Engine dataset —
 * deliberately not the primary D1 database: the retirement readout is a pure
 * aggregate (no joins), and `writeDataPoint` is non-blocking so recording
 * stays off the request hot path. Without the binding (local dev, tests)
 * recording is a no-op. Recording never throws.
 *
 * Retirement readout (Analytics Engine SQL API; counts must be weighted by
 * `_sample_interval` because Analytics Engine samples at high volume):
 *
 * ```sql
 * SELECT blob1 AS lane, blob4 AS client_name, SUM(_sample_interval) AS requests
 * FROM kody_mcp_protocol_events
 * WHERE timestamp > NOW() - INTERVAL '30' DAY
 * GROUP BY lane, client_name
 * ORDER BY requests DESC
 * ```
 *
 * Package identity param readout (evidence for retiring the public MCP
 * `kody_id` input alias; blob8 is empty for non-`tools/call` traffic):
 *
 * ```sql
 * SELECT blob8 AS package_identity_param, SUM(_sample_interval) AS requests
 * FROM kody_mcp_protocol_events
 * WHERE timestamp > NOW() - INTERVAL '30' DAY
 *   AND blob2 = 'tools/call'
 *   AND blob8 != ''
 * GROUP BY package_identity_param
 * ORDER BY requests DESC
 * ```
 *
 * Weekly leftover gate for #3676 (removal waits until `kody_id` + `both` stay
 * under about 10 requests/week for two consecutive weeks; counts only):
 *
 * ```sql
 * SELECT
 *   toStartOfWeek(timestamp) AS week_start,
 *   SUM(_sample_interval) AS kody_id_calls
 * FROM kody_mcp_protocol_events
 * WHERE timestamp > NOW() - INTERVAL '28' DAY
 *   AND blob2 = 'tools/call'
 *   AND blob8 IN ('kody_id', 'both')
 * GROUP BY week_start
 * ORDER BY week_start DESC
 * ```
 */

import type * as McpServerModule from '@modelcontextprotocol/server'
import { isRecord } from '@kody-internal/shared/is-record.ts'

export type McpProtocolLane = 'legacy' | 'modern'

/**
 * How a `tools/call` identified a package (top-level or nested `target`).
 * Empty string for non-`tools/call` requests. Used as AE blob8 evidence for
 * retiring the public MCP `kody_id` input alias (#1909).
 */
export type McpPackageIdentityParam =
	| ''
	| 'kody_id'
	| 'package_id'
	| 'name'
	| 'both'
	| 'none'

export type McpProtocolEventEnv = {
	MCP_PROTOCOL_EVENTS?: AnalyticsEngineDataset
}

export type McpProtocolClassification = {
	lane: McpProtocolLane
	/** JSON-RPC method for POSTs, `http:GET` / `http:DELETE` for session operations. */
	method: string
	/** Protocol revision claimed by the request (`_meta` envelope or negotiated header). */
	protocolVersion: string
	clientName: string
	clientVersion: string
	/**
	 * Package identity param used on `tools/call` (empty for other methods).
	 * See {@link McpPackageIdentityParam}.
	 */
	packageIdentityParam: McpPackageIdentityParam
	/**
	 * Parsed JSON body for POST requests, when parseable. Callers forward it
	 * to the stateless handler so the body is parsed at most once per request.
	 */
	parsedBody?: unknown
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

function hasNonEmptyString(value: unknown, key: string): boolean {
	if (!isRecord(value)) return false
	const field = value[key]
	return typeof field === 'string' && field.trim().length > 0
}

/**
 * Classify which package-identity input a tools/call used. Nested `target`
 * covers repo tools that wrap package identity; nested `params` covers the MCP
 * `api` tool only (`arguments.params.kody_id`). `execute` also has a `params`
 * bag for arbitrary user-code input — that must not count as package-alias
 * use. `name` is counted only when it looks like a scoped package name
 * (`@scope/leaf`); bare names are usually plain repos or person names and are
 * not package-identity evidence.
 */
export function classifyMcpPackageIdentityParam(
	toolArguments: unknown,
	options?: { toolName?: string },
): McpPackageIdentityParam {
	const bags: Array<unknown> = [toolArguments]
	if (isRecord(toolArguments)) {
		if (isRecord(toolArguments['target'])) {
			bags.push(toolArguments['target'])
		}
		if (options?.toolName === 'api' && isRecord(toolArguments['params'])) {
			bags.push(toolArguments['params'])
		}
	}
	let hasKodyId = false
	let hasPackageId = false
	let hasScopedName = false
	for (const bag of bags) {
		// Count both snake_case and camelCase spellings. MCP / OpenAPI leftover
		// callers still send `kodyId` / `packageId` (webhookList, enablements,
		// credentials); omitting them under-counts the #3676 weekly gate.
		if (hasNonEmptyString(bag, 'kody_id') || hasNonEmptyString(bag, 'kodyId')) {
			hasKodyId = true
		}
		if (
			hasNonEmptyString(bag, 'package_id') ||
			hasNonEmptyString(bag, 'packageId')
		) {
			hasPackageId = true
		}
		if (hasNonEmptyString(bag, 'name')) {
			const name = isRecord(bag) ? readString(bag['name']).trim() : ''
			if (name.startsWith('@') && name.includes('/')) hasScopedName = true
		}
	}
	if (hasKodyId && hasPackageId) return 'both'
	if (hasKodyId) return 'kody_id'
	if (hasPackageId) return 'package_id'
	if (hasScopedName) return 'name'
	return 'none'
}

/** First JSON-RPC message of a body (batch arrays classify by their first entry). */
function firstJsonRpcMessage(body: unknown): Record<string, unknown> | null {
	if (Array.isArray(body)) {
		const first = body.find(isRecord)
		return first ?? null
	}
	return isRecord(body) ? body : null
}

/**
 * Classify one authenticated `/mcp` request into its serving lane and extract
 * the metric fields. Uses the SDK's own {@link isLegacyRequest} predicate —
 * the exact classifier `createMcpHandler` runs — so routing and metrics can
 * never disagree. The request body is read from a clone; the request stays
 * fully readable for whichever lane serves it.
 */
let mcpServerModuleMemo: Promise<typeof McpServerModule> | null = null

/**
 * `@modelcontextprotocol/server` builds the wire schemas for every protocol
 * revision when it evaluates, which is a large share of Worker startup CPU.
 * Every consumer on origin runs inside a request, so the module is loaded on
 * first use and cached for the isolate. Keep static imports of that package
 * off the startup path (see `docs/contributing/architecture/startup-budget.md`).
 */
export function loadMcpServerModule(): Promise<typeof McpServerModule> {
	mcpServerModuleMemo ??= import('@modelcontextprotocol/server').catch(
		(error: unknown) => {
			mcpServerModuleMemo = null
			throw error
		},
	)
	return mcpServerModuleMemo
}

export async function classifyMcpProtocolRequest(
	request: Request,
): Promise<McpProtocolClassification> {
	const { CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, isLegacyRequest } =
		await loadMcpServerModule()
	let parsedBody: unknown
	let hasParsedBody = false
	if (request.method === 'POST') {
		try {
			parsedBody = await request.clone().json()
			hasParsedBody = true
		} catch {
			// Empty or invalid JSON classifies legacy; the lane handler owns
			// the error response.
		}
	}
	const legacy = hasParsedBody
		? await isLegacyRequest(request, parsedBody)
		: await isLegacyRequest(request)
	const lane: McpProtocolLane = legacy ? 'legacy' : 'modern'

	if (request.method !== 'POST') {
		return {
			lane,
			method: `http:${request.method}`,
			protocolVersion: readString(request.headers.get('mcp-protocol-version')),
			clientName: '',
			clientVersion: '',
			packageIdentityParam: '',
		}
	}

	const message = firstJsonRpcMessage(parsedBody)
	const method = readString(message?.['method']) || 'unknown'
	const meta = isRecord(message?.['params'])
		? message['params']['_meta']
		: undefined
	const params = isRecord(message?.['params']) ? message['params'] : undefined

	// Modern requests carry the revision in the `_meta` envelope; legacy
	// requests send the negotiated `mcp-protocol-version` header (or name the
	// offered revision in the `initialize` params).
	const protocolVersion =
		(isRecord(meta) ? readString(meta[PROTOCOL_VERSION_META_KEY]) : '') ||
		readString(request.headers.get('mcp-protocol-version')) ||
		(method === 'initialize' ? readString(params?.['protocolVersion']) : '')

	const clientInfo = isRecord(meta)
		? meta[CLIENT_INFO_META_KEY]
		: method === 'initialize'
			? params?.['clientInfo']
			: undefined

	const toolName =
		method === 'tools/call' && isRecord(params)
			? readString(params['name'])
			: ''
	const toolArguments =
		method === 'tools/call' && isRecord(params)
			? params['arguments']
			: undefined
	const packageIdentityParam =
		method === 'tools/call'
			? classifyMcpPackageIdentityParam(toolArguments, { toolName })
			: ''

	return {
		lane,
		method,
		protocolVersion,
		clientName: isRecord(clientInfo) ? readString(clientInfo['name']) : '',
		clientVersion: isRecord(clientInfo)
			? readString(clientInfo['version'])
			: '',
		packageIdentityParam,
		...(hasParsedBody ? { parsedBody } : {}),
	}
}

/**
 * Record one lane data point. Non-blocking, never throws, no-op without the
 * Analytics Engine binding.
 */
export function recordMcpProtocolEvent(
	env: McpProtocolEventEnv,
	input: Omit<McpProtocolClassification, 'parsedBody'> & {
		userId?: string
		requestHost?: string
	},
): void {
	try {
		env.MCP_PROTOCOL_EVENTS?.writeDataPoint({
			// Indexed by lane so Analytics Engine sampling stays independent
			// per lane and low-volume modern traffic is never drowned out.
			indexes: [input.lane],
			blobs: [
				input.lane,
				input.method,
				input.protocolVersion,
				input.clientName,
				input.clientVersion,
				input.userId ?? '',
				// blob7: request host, so domain migrations can measure which
				// users still connect through a legacy hostname.
				input.requestHost ?? '',
				// blob8: package identity param on tools/call (kody_id vs
				// package_id vs scoped name) for the public MCP param gate.
				input.packageIdentityParam,
			],
			doubles: [1],
		})
	} catch (error) {
		console.warn('mcp-protocol-event-failed', error)
	}
}
