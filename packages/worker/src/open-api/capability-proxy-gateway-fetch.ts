import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { secretAuthorityHeaderName } from '#mcp/secrets/secret-authority.ts'
import { capabilityProxyCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	capabilityProxyAuthenticatedFetchMaxBodyBytes,
	serializeAuthenticatedFetchResponse,
	type CapabilityProxyAuthenticatedFetchResult,
} from './capability-proxy-authenticated-fetch.ts'
import { authorizeLocalExecutePackageBinding } from './capability-proxy-package-grants.ts'
import type { ApiInvocationContext } from './context.ts'
import { invalidRequest } from './errors.ts'

/**
 * CapabilityProxy bridge for local ambient `fetch` that carries
 * `{{secret:…}}` / `{{integration-token:…}}` placeholders. Origin runs the
 * same `executeGatewayFetch` / `expandSecretPlaceholders` path as cloud
 * execute, so secret plaintext never enters local workerd and missing
 * secrets fail closed before any third-party request.
 *
 * Optional `packageId` is the package graph's signed binding from local
 * workerd (never a bare id). Origin verifies it and `package:execute`, then passes it as a `claimed` package stamp: it binds
 * package-scoped secrets / package-limited integrations, but the actor still
 * needs `secret:use` / `integration:use`. Only attested packages skip Use.
 *
 * Local execute has no run cap, so the gateway's 5-minute overall fetch
 * deadline is the only bound on time. The response is buffered before it is
 * returned (no streaming to local workerd), and a body over
 * `capabilityProxyAuthenticatedFetchMaxBodyBytes` (4 MiB) fails.
 */

export type CapabilityProxyGatewayFetchRequest = {
	packageId?: string
	request: {
		url: string
		method?: string
		headers?: Record<string, string>
		body?: string
		bodyBase64?: string
	}
}

export function parseCapabilityProxyGatewayFetchArgs(
	args: ReadonlyArray<unknown>,
): CapabilityProxyGatewayFetchRequest {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		throw invalidRequest(
			'gatewayFetch requires a single object argument: { request, packageId? }.',
		)
	}
	const record = first as Record<string, unknown>
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
			'gatewayFetch requires request: { url, method?, headers?, body?, bodyBase64? }.',
		)
	}
	const request = requestValue as Record<string, unknown>
	const url = typeof request.url === 'string' ? request.url.trim() : ''
	if (!url) {
		throw invalidRequest('gatewayFetch request.url must be a non-empty string.')
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
	const hasBody = Object.hasOwn(request, 'body') && request.body !== undefined
	const hasBodyBase64 =
		Object.hasOwn(request, 'bodyBase64') && request.bodyBase64 !== undefined
	if (hasBody && hasBodyBase64) {
		throw invalidRequest(
			'gatewayFetch request may include body or bodyBase64, not both.',
		)
	}
	if (hasBody && typeof request.body !== 'string') {
		throw invalidRequest(
			'gatewayFetch request.body must be a string when provided.',
		)
	}
	if (hasBodyBase64 && typeof request.bodyBase64 !== 'string') {
		throw invalidRequest(
			'gatewayFetch request.bodyBase64 must be a string when provided.',
		)
	}
	let body: string | undefined
	let bodyBase64: string | undefined
	let byteLength = 0
	if (hasBody) {
		body = request.body as string
		byteLength = new TextEncoder().encode(body).byteLength
	} else if (hasBodyBase64) {
		bodyBase64 = request.bodyBase64 as string
		try {
			byteLength = base64ToBytes(bodyBase64).byteLength
		} catch {
			throw invalidRequest(
				'gatewayFetch request.bodyBase64 is not valid base64.',
			)
		}
	}
	if (byteLength > capabilityProxyAuthenticatedFetchMaxBodyBytes) {
		throw invalidRequest(
			`gatewayFetch request body exceeds ${capabilityProxyAuthenticatedFetchMaxBodyBytes} bytes.`,
		)
	}
	return {
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

export async function runCapabilityProxyGatewayFetch(input: {
	ctx: ApiInvocationContext
	args: ReadonlyArray<unknown>
}): Promise<CapabilityProxyAuthenticatedFetchResult> {
	const call = parseCapabilityProxyGatewayFetchArgs(input.args)
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
	const requestBody =
		call.request.bodyBase64 !== undefined
			? base64ToBytes(call.request.bodyBase64)
			: call.request.body
	const headers = new Headers(call.request.headers)
	headers.delete(secretAuthorityHeaderName)
	const response = await executeGatewayFetch({
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
		request: new Request(call.request.url, {
			method: call.request.method,
			headers,
			body: requestBody,
		}),
		...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
	})
	return serializeAuthenticatedFetchResponse(response)
}
