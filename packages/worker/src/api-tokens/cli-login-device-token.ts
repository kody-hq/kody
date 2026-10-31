import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type ApiInvocationContext } from '#worker/open-api/context.ts'
import { invalidRequest } from '#worker/open-api/errors.ts'
import {
	mintApiToken,
	resolveApiTokenLifetime,
	type ApiTokenSecretView,
} from './service.ts'

export const cliLoginDeviceTokenName = 'kody-cli'

/**
 * Scopes on a `kody login` device token. The full org-permission vocabulary
 * so `kody api` can call every Open API operation the caller's role allows.
 * `authorize` still intersects this list with the org role.
 */
export const cliLoginDeviceTokenScopes = orgPermissions

export async function mintCliLoginDeviceToken(input: {
	ctx: ApiInvocationContext
	lifetime?: string
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	name?: string
}): Promise<ApiTokenSecretView & { login_org: { slug: string } | null }> {
	if (input.ctx.principal.kind !== 'mcp-oauth') {
		throw invalidRequest(
			'POST /v1/tokens/device accepts the official CLI login OAuth access token. Send that bearer once; store the returned kody_at_ token.',
		)
	}
	let lifetime: ReturnType<typeof resolveApiTokenLifetime>
	try {
		lifetime = resolveApiTokenLifetime({
			lifetime: input.lifetime,
			idleTtlSeconds: input.idleTtlSeconds,
			maxLifetimeSeconds: input.maxLifetimeSeconds,
		})
	} catch (error) {
		if (error instanceof McpCallerError) throw invalidRequest(error.message)
		throw error
	}
	try {
		const minted = await mintApiToken({
			db: input.ctx.env.APP_DB,
			userId: input.ctx.callerContext.user.userId,
			orgBinding: 'user',
			name: input.name?.trim() || cliLoginDeviceTokenName,
			scopes: cliLoginDeviceTokenScopes,
			idleTtlSeconds: lifetime.idleTtlSeconds,
			maxLifetimeSeconds: lifetime.maxLifetimeSeconds,
			createdVia: 'cli-login',
		})
		const slug = input.ctx.callerContext.request?.org.slug?.trim() ?? ''
		return {
			...minted,
			login_org: slug ? { slug } : null,
		}
	} catch (error) {
		if (error instanceof McpCallerError) throw invalidRequest(error.message)
		throw error
	}
}
