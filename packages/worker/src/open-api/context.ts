import { type EcpGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	resolveCallerFeatureFlags,
	type CallerFeatureFlags,
} from '#mcp/capabilities/access-control.ts'
import { type ApiTokenRecord } from '#worker/api-tokens/service.ts'
import { type CapabilityOpenApiPrincipal } from '#mcp/capabilities/types.ts'

/**
 * Who is calling the Open API.
 *
 * - `token` — HTTP request authenticated by a scoped `kody_at_` API token.
 * - `mcp` — the MCP `api` tool, which already holds the user's full MCP grant,
 *   so scope checks do not apply.
 * - `mcp-oauth` — CLI `kody login` MCP OAuth access token on local-execute HTTP
 *   surfaces only (CapabilityProxy + package-graph). Same full MCP grant as a
 *   session for those routes; API-token scope checks are skipped. See ADR 0055.
 */
export type ApiPrincipal =
	| { kind: 'token'; token: ApiTokenRecord }
	| { kind: 'mcp' }
	| {
			kind: 'mcp-oauth'
			/** Access-token expiry as Unix seconds (OAuth provider). */
			expiresAtUnix: number
			/** OIDC grant scopes (`openid` / `profile` / `email`), not API scopes. */
			grantScopes: Array<string>
	  }
	/**
	 * A run on a registered execution context calling back into Kody as its
	 * requester: authenticated per request by the context's signature and an
	 * active lease, never by a bearer token.
	 */
	| {
			kind: 'execution-context-run'
			ecid: string
			runId: string
			/** Lease deadline (epoch ms). */
			deadline: number
			/** The requester's credential scopes; null does not narrow. */
			scopes: Array<string> | null
			runtime: EcpGrant['runtime']
			/** Credential ids the context's grant allows; empty means none. */
			credentialIds: Array<string>
	  }

export function toCapabilityOpenApiPrincipal(
	principal: ApiPrincipal,
): CapabilityOpenApiPrincipal {
	switch (principal.kind) {
		case 'token':
			return { kind: 'token', token: principal.token }
		case 'mcp':
			return { kind: 'mcp' }
		case 'mcp-oauth':
			return { kind: 'mcp-oauth' }
		case 'execution-context-run':
			return {
				kind: 'execution-context-run',
				ecid: principal.ecid,
				runId: principal.runId,
			}
	}
}

export type ApiInvocationContext = {
	env: Env
	callerContext: McpCallerContext & {
		user: NonNullable<McpCallerContext['user']>
	}
	principal: ApiPrincipal
	waitUntil?: (promise: Promise<unknown>) => void
	/** Worker entrypoint exports for hosted execute loopback. */
	loopbackExports?: Cloudflare.Exports
	/** Memoized per invocation; resolves on first flag-gated check. */
	getFeatureFlags: () => Promise<CallerFeatureFlags>
}

export function createApiInvocationContext(input: {
	env: Env
	callerContext: ApiInvocationContext['callerContext']
	principal: ApiPrincipal
	waitUntil?: (promise: Promise<unknown>) => void
}): ApiInvocationContext {
	let featureFlags: Promise<CallerFeatureFlags> | null = null
	return {
		...input,
		getFeatureFlags() {
			featureFlags ??= resolveCallerFeatureFlags(input.env, input.callerContext)
			return featureFlags
		},
	}
}
