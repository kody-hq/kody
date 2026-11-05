import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import {
	BoundedBodyTooLargeError,
	readBoundedBodyBytes,
} from '#mcp/capabilities/integrations/read-bounded-body.ts'
import { createAuthenticatedFetch } from '#mcp/execute-modules/kody-runtime-utils.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { createHostIntegrationAuthority } from '#mcp/capabilities/integrations/host-integration-authority.ts'
import { secretAuthorityHeaderName } from '#mcp/secrets/secret-authority.ts'
import { claimedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeLocalExecutePackageBinding } from './capability-proxy-package-grants.ts'
import type { ApiInvocationContext } from './context.ts'
import { invalidRequest } from './errors.ts'

/**
 * CapabilityProxy bridge for local `createAuthenticatedFetch`: the CLI / local
 * workerd never sees OAuth access tokens. Host expands
 * `{{integration-token:…}}` through the same fetch gateway cloud execute uses,
 * then returns a JSON-safe response envelope the local runtime reconstructs.
 *
 * Optional `packageId` is the package graph's signed binding (never a bare
 * id): origin verifies the binding and `package:execute` when present, but never grants secret authority from it. Local credential
 * expansion requires `integration:use` / `secret:use` like ad-hoc; only cloud
 * bundler provenance may skip Use via package attachment.
 */

export const capabilityProxyAuthenticatedFetchMaxBodyBytes = 4 * 1024 * 1024

export type CapabilityProxyAuthenticatedFetchRequest = {
	providerName: string
	packageId?: string
	request: {
		url: string
		method?: string
		headers?: Record<string, string>
		/** UTF-8 text body (mutually exclusive with bodyBase64). */
		body?: string
		/** Binary-safe body (mutually exclusive with body). */
		bodyBase64?: string
	}
}

export type CapabilityProxyAuthenticatedFetchResult = {
	status: number
	statusText: string
	headers: Record<string, string>
	bodyBase64: string
}

export function parseCapabilityProxyAuthenticatedFetchArgs(
	args: ReadonlyArray<unknown>,
): CapabilityProxyAuthenticatedFetchRequest {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		throw invalidRequest(
			'authenticatedFetch requires a single object argument: { providerName, request }.',
		)
	}
	const record = first as Record<string, unknown>
	const providerName =
		typeof record.providerName === 'string' ? record.providerName.trim() : ''
	if (!providerName) {
		throw invalidRequest(
			'authenticatedFetch requires a non-empty providerName.',
		)
	}
	const packageId =
		typeof record.packageId === 'string' && record.packageId.trim()
			? record.packageId.trim()
			: undefined
	const requestValue = record.request
	if (
		requestValue == null ||
		typeof requestValue !== 'object' ||
		Array.isArray(requestValue)
	) {
		throw invalidRequest(
			'authenticatedFetch requires request: { url, method?, headers?, body?, bodyBase64? }.',
		)
	}
	const request = requestValue as Record<string, unknown>
	const url = typeof request.url === 'string' ? request.url.trim() : ''
	if (!url) {
		throw invalidRequest(
			'authenticatedFetch request.url must be a non-empty string.',
		)
	}
	const method =
		typeof request.method === 'string' && request.method.trim()
			? request.method.trim()
			: 'GET'
	const headers =
		request.headers != null &&
		typeof request.headers === 'object' &&
		!Array.isArray(request.headers)
			? Object.fromEntries(
					Object.entries(request.headers as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			: undefined
	const hasBody = request.body !== undefined
	const hasBodyBase64 = request.bodyBase64 !== undefined
	if (hasBody && hasBodyBase64) {
		throw invalidRequest(
			'authenticatedFetch request may include body or bodyBase64, not both.',
		)
	}
	if (hasBody && typeof request.body !== 'string') {
		throw invalidRequest(
			'authenticatedFetch request.body must be a string when provided.',
		)
	}
	if (hasBodyBase64 && typeof request.bodyBase64 !== 'string') {
		throw invalidRequest(
			'authenticatedFetch request.bodyBase64 must be a string when provided.',
		)
	}
	const body = typeof request.body === 'string' ? request.body : undefined
	const bodyBase64 =
		typeof request.bodyBase64 === 'string' ? request.bodyBase64 : undefined
	if (body !== undefined) {
		assertBodyByteLength(new TextEncoder().encode(body).byteLength)
	}
	if (bodyBase64 !== undefined) {
		let decoded: Uint8Array
		try {
			decoded = base64ToBytes(bodyBase64)
		} catch {
			throw invalidRequest(
				'authenticatedFetch request.bodyBase64 is not valid base64.',
			)
		}
		assertBodyByteLength(decoded.byteLength)
	}
	return {
		providerName,
		...(packageId ? { packageId } : {}),
		request: {
			url,
			method,
			...(headers ? { headers } : {}),
			...(body !== undefined ? { body } : {}),
			...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
		},
	}
}

function assertBodyByteLength(byteLength: number) {
	if (byteLength > capabilityProxyAuthenticatedFetchMaxBodyBytes) {
		throw invalidRequest(
			`authenticatedFetch request body exceeds ${capabilityProxyAuthenticatedFetchMaxBodyBytes} bytes.`,
		)
	}
}

async function authorizeAuthenticatedFetchPackageId(input: {
	ctx: ApiInvocationContext
	packageId: string
}) {
	return await authorizeLocalExecutePackageBinding({
		db: input.ctx.env.APP_DB,
		env: input.ctx.env,
		request: input.ctx.callerContext.request,
		orgUserId: ownerIdFromCaller(input.ctx.callerContext),
		packageBinding: input.packageId,
	})
}

export async function runCapabilityProxyAuthenticatedFetch(input: {
	ctx: ApiInvocationContext
	args: ReadonlyArray<unknown>
}): Promise<CapabilityProxyAuthenticatedFetchResult> {
	const call = parseCapabilityProxyAuthenticatedFetchArgs(input.args)
	const orgUserId = ownerIdFromCaller(input.ctx.callerContext)
	const stampedPackageId = call.packageId
		? await authorizeAuthenticatedFetchPackageId({
				ctx: input.ctx,
				packageId: call.packageId,
			})
		: null
	// Config read, gateway fetch, and refresh all act as the verified local
	// binding, claimed. Never the run's attested storage package.
	const authority = createHostIntegrationAuthority({
		env: input.ctx.env,
		callerContext: input.ctx.callerContext,
		...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
		packageStamp: claimedPackageStamp(stampedPackageId),
	})
	const existingStorage = input.ctx.callerContext.storageContext
	const storageContext = {
		sessionId: existingStorage?.sessionId ?? null,
		appId: existingStorage?.appId ?? null,
		packageId: null,
		storageId: existingStorage?.storageId ?? null,
	}
	const gatewayFetch: typeof fetch = async (requestInput, init) => {
		const request = new Request(requestInput, init)
		const headers = new Headers(request.headers)
		headers.delete(secretAuthorityHeaderName)
		return executeGatewayFetch({
			env: input.ctx.env,
			props: {
				baseUrl: input.ctx.callerContext.baseUrl,
				userId: orgUserId,
				email: input.ctx.callerContext.user.email,
				request: input.ctx.callerContext.request,
				storageContext,
				claimedPackageId: stampedPackageId,
			},
			request: new Request(request, { headers }),
			...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
		})
	}
	const authenticatedFetch = await createAuthenticatedFetch(
		authority,
		call.providerName,
		{ fetch: gatewayFetch },
	)
	const requestBody =
		call.request.bodyBase64 !== undefined
			? base64ToBytes(call.request.bodyBase64)
			: call.request.body
	const response = await authenticatedFetch(call.request.url, {
		method: call.request.method,
		headers: call.request.headers,
		body: requestBody,
	})
	return serializeAuthenticatedFetchResponse(response)
}

export async function serializeAuthenticatedFetchResponse(
	response: Response,
): Promise<CapabilityProxyAuthenticatedFetchResult> {
	let buffer: Uint8Array
	try {
		buffer = await readBoundedBodyBytes(
			response,
			capabilityProxyAuthenticatedFetchMaxBodyBytes,
		)
	} catch (error) {
		if (error instanceof BoundedBodyTooLargeError) {
			throw invalidRequest(
				`authenticatedFetch response body exceeds ${capabilityProxyAuthenticatedFetchMaxBodyBytes} bytes for local execute. Use a smaller response projection, or cloud execute for large payloads.`,
			)
		}
		throw error
	}
	const headers: Record<string, string> = {}
	response.headers.forEach((value, key) => {
		headers[key] = value
	})
	return {
		status: response.status,
		statusText: response.statusText,
		headers,
		bodyBase64: bytesToBase64(buffer),
	}
}
