import {
	executeGatewayFetch,
	secretResolutionHeaderName,
} from '#mcp/fetch-gateway.ts'
import { secretAuthorityHeaderName } from '#mcp/secrets/secret-authority.ts'
import { capabilityProxyCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeLocalExecutePackageBinding } from './capability-proxy-package-grants.ts'
import { type ApiInvocationContext } from './context.ts'
import { ApiError, invalidRequest } from './errors.ts'
import {
	assertContextRunSpecialPathAllowed,
	requireLocalExecuteHttpPrincipal,
} from './native-operation-helpers.ts'

/**
 * Cloudflare Worker request upload limit on Free/Pro. Matches the api-worker
 * edge constant of the same name.
 */
export const maxGatewayFetchUploadBytes = 100 * 1024 * 1024

export const gatewayFetchUrlHeaderName = 'X-Kody-Gateway-Url'
export const gatewayFetchMethodHeaderName = 'X-Kody-Gateway-Method'
export const gatewayFetchPackageIdHeaderName = 'X-Kody-Gateway-Package-Id'
export const gatewayFetchHeadersHeaderName = 'X-Kody-Gateway-Headers'

export function gatewayFetchUploadLimitMessage() {
	return `Request body exceeds the Worker upload limit of ${maxGatewayFetchUploadBytes} bytes (100 MiB).`
}

export type CapabilityProxyGatewayFetchStreamMetadata = {
	url: string
	method: string
	packageId?: string
	headers?: Record<string, string>
}

export function parseCapabilityProxyGatewayFetchStreamHeaders(
	headers: Headers,
): CapabilityProxyGatewayFetchStreamMetadata {
	const url = headers.get(gatewayFetchUrlHeaderName)?.trim() ?? ''
	if (!url) {
		throw invalidRequest(
			'X-Kody-Gateway-Url is required and must be a non-empty absolute URL.',
		)
	}
	try {
		new URL(url)
	} catch {
		throw invalidRequest('X-Kody-Gateway-Url must be an absolute URL.')
	}
	const method = headers.get(gatewayFetchMethodHeaderName)?.trim() || 'GET'
	const packageId = headers.get(gatewayFetchPackageIdHeaderName)?.trim()
	const rawHeaders = headers.get(gatewayFetchHeadersHeaderName)
	return {
		url,
		method,
		...(packageId ? { packageId } : {}),
		...(rawHeaders != null && rawHeaders !== ''
			? { headers: parseOutboundHeadersJson(rawHeaders) }
			: {}),
	}
}

function parseOutboundHeadersJson(raw: string): Record<string, string> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw invalidRequest(
			'X-Kody-Gateway-Headers must be valid JSON: an object of header names to string values.',
		)
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw invalidRequest(
			'X-Kody-Gateway-Headers must be a JSON object of header names to string values.',
		)
	}
	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== 'string') {
			throw invalidRequest(
				`X-Kody-Gateway-Headers value for "${key}" must be a string.`,
			)
		}
		headers[key] = value
	}
	return headers
}

export function assertGatewayFetchContentLength(headers: Headers) {
	const declared = Number(headers.get('Content-Length') ?? '0')
	if (Number.isFinite(declared) && declared > maxGatewayFetchUploadBytes) {
		throw new ApiError({
			status: 413,
			code: 'payload_too_large',
			message: gatewayFetchUploadLimitMessage(),
		})
	}
}

function shouldSendBody(method: string) {
	const normalized = method.toUpperCase()
	return normalized !== 'GET' && normalized !== 'HEAD'
}

/**
 * Streaming CapabilityProxy hop: the Open API request body is the outbound
 * fetch body. Metadata lives in allowlisted headers. Returns the upstream
 * Response directly (not `{ status, headers, bodyBase64 }`).
 */
export async function runCapabilityProxyGatewayFetchStream(input: {
	ctx: ApiInvocationContext
	request: Request
}): Promise<Response> {
	requireLocalExecuteHttpPrincipal(input.ctx)
	// Same gate as the JSON gatewayFetch hop; the credential door then checks
	// each filled credential against the context's list.
	assertContextRunSpecialPathAllowed(input.ctx, ['kody', 'gatewayFetch'])
	assertGatewayFetchContentLength(input.request.headers)
	const call = parseCapabilityProxyGatewayFetchStreamHeaders(
		input.request.headers,
	)
	const orgUserId = ownerIdFromCaller(input.ctx.callerContext)
	const stampedPackageId = call.packageId
		? await authorizeLocalExecutePackageBinding({
				db: input.ctx.env.APP_DB,
				env: input.ctx.env,
				request: input.ctx.callerContext.request,
				orgUserId,
				packageBinding: call.packageId,
			})
		: null
	const existingStorage = input.ctx.callerContext.storageContext
	const storageContext = {
		sessionId: existingStorage?.sessionId ?? null,
		appId: existingStorage?.appId ?? null,
		packageId: null,
		storageId: existingStorage?.storageId ?? null,
	}
	const headers = new Headers(call.headers)
	headers.delete(secretAuthorityHeaderName)
	const contentType = input.request.headers.get('Content-Type')
	if (contentType) headers.set('Content-Type', contentType)
	const resolution = input.request.headers.get(secretResolutionHeaderName)
	if (resolution) headers.set(secretResolutionHeaderName, resolution)
	const outboundInit: RequestInit & { duplex?: 'half' } = {
		method: call.method,
		headers,
	}
	if (input.request.body && shouldSendBody(call.method)) {
		outboundInit.body = input.request.body
		outboundInit.duplex = 'half'
	}
	return executeGatewayFetch({
		env: input.ctx.env,
		props: {
			baseUrl: input.ctx.callerContext.baseUrl,
			userId: orgUserId,
			email: input.ctx.callerContext.user.email,
			request: input.ctx.callerContext.request,
			storageContext,
			claimedPackageId: stampedPackageId,
			credentialClientBinding: input.ctx.callerContext.request
				? capabilityProxyCredentialClientBinding(
						input.ctx.callerContext.request,
					)
				: null,
		},
		request: new Request(call.url, outboundInit),
		...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
	})
}
