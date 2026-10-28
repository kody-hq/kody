import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { capabilityProxyCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import {
	oauthClientCredentials,
	type OAuthClientCredentialsInput,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import { secretAuthorityHeaderName } from '#mcp/secrets/secret-authority.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeLocalExecutePackageBinding } from './capability-proxy-package-grants.ts'
import { type ApiInvocationContext } from './context.ts'
import { invalidRequest } from './errors.ts'

/**
 * CapabilityProxy bridge for local `oauthClientCredentials`: origin expands
 * secret placeholders through the fetch gateway (same as cloud execute), so
 * client id/secret values never enter local workerd.
 *
 * Optional `packageId` is the package graph's signed binding (never a bare
 * id): origin verifies the binding and `package:execute` when present, but never grants secret authority from it. Local expansion
 * requires `secret:use` like ad-hoc.
 */

export type CapabilityProxyOauthClientCredentialsRequest =
	OAuthClientCredentialsInput & {
		packageId?: string
	}

export function parseCapabilityProxyOauthClientCredentialsArgs(
	args: ReadonlyArray<unknown>,
): CapabilityProxyOauthClientCredentialsRequest {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		throw invalidRequest(
			'oauthClientCredentials requires a single object argument: { tokenUrl, clientIdSecret, clientSecretSecret, ... }.',
		)
	}
	const record = first as Record<string, unknown>
	const tokenUrl = record.tokenUrl
	if (
		!(typeof tokenUrl === 'string' && tokenUrl.trim()) &&
		!(tokenUrl instanceof URL)
	) {
		throw invalidRequest(
			'oauthClientCredentials requires a non-empty tokenUrl string or URL.',
		)
	}
	const clientIdSecret =
		typeof record.clientIdSecret === 'string'
			? record.clientIdSecret.trim()
			: ''
	const clientSecretSecret =
		typeof record.clientSecretSecret === 'string'
			? record.clientSecretSecret.trim()
			: ''
	if (!clientIdSecret || !clientSecretSecret) {
		throw invalidRequest(
			'oauthClientCredentials requires clientIdSecret and clientSecretSecret.',
		)
	}
	const authStyle = record.authStyle
	if (authStyle != null && authStyle !== 'basic') {
		throw invalidRequest(
			`Unsupported OAuth client_credentials authStyle "${String(authStyle)}".`,
		)
	}
	const scope =
		typeof record.scope === 'string' || record.scope == null
			? (record.scope as OAuthClientCredentialsInput['scope'])
			: undefined
	const body =
		record.body != null &&
		typeof record.body === 'object' &&
		!Array.isArray(record.body)
			? Object.fromEntries(
					Object.entries(record.body as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			: undefined
	const headers =
		record.headers != null &&
		typeof record.headers === 'object' &&
		!Array.isArray(record.headers)
			? Object.fromEntries(
					Object.entries(record.headers as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			: undefined
	const packageId =
		typeof record.packageId === 'string' && record.packageId.trim()
			? record.packageId.trim()
			: undefined
	return {
		tokenUrl: tokenUrl as string | URL,
		clientIdSecret,
		clientSecretSecret,
		...(authStyle === 'basic' ? { authStyle: 'basic' as const } : {}),
		...(scope !== undefined ? { scope } : {}),
		...(body ? { body } : {}),
		...(headers ? { headers } : {}),
		...(packageId ? { packageId } : {}),
	}
}

async function authorizeOauthClientCredentialsPackageId(input: {
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

export async function runCapabilityProxyOauthClientCredentials(input: {
	ctx: ApiInvocationContext
	args: ReadonlyArray<unknown>
}) {
	const call = parseCapabilityProxyOauthClientCredentialsArgs(input.args)
	const user = input.ctx.callerContext.user
	if (!user) {
		throw invalidRequest(
			'oauthClientCredentials requires an authenticated user.',
		)
	}
	const orgUserId = ownerIdFromCaller(input.ctx.callerContext)
	const stampedPackageId = call.packageId
		? await authorizeOauthClientCredentialsPackageId({
				ctx: input.ctx,
				packageId: call.packageId,
			})
		: null
	const existingStorage = input.ctx.callerContext.storageContext
	const storageContext = {
		sessionId: existingStorage?.sessionId ?? null,
		appId: existingStorage?.appId ?? null,
		packageId: null,
		storageId: existingStorage?.storageId ?? null,
	}
	const { packageId: _ignoredPackageId, ...oauthInput } = call
	const gatewayFetch: typeof fetch = async (requestInput, init) => {
		const request = new Request(requestInput, init)
		const headers = new Headers(request.headers)
		headers.delete(secretAuthorityHeaderName)
		return executeGatewayFetch({
			env: input.ctx.env,
			props: {
				baseUrl: input.ctx.callerContext.baseUrl,
				userId: orgUserId,
				email: user.email,
				request: input.ctx.callerContext.request,
				storageContext,
				claimedPackageId: stampedPackageId,
				// Same binding as local gatewayFetch, so the sealed token fills there.
				credentialClientBinding: input.ctx.callerContext.request
					? capabilityProxyCredentialClientBinding(
							input.ctx.callerContext.request,
						)
					: null,
			},
			request: new Request(request, { headers }),
			...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
		})
	}

	// The gateway seals the token fields, so the result holds no token.
	return await oauthClientCredentials(oauthInput, { fetch: gatewayFetch })
}
