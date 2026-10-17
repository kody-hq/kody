import {
	type AuthenticatedAppUser,
	readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { orgSectionDenial } from '#app/org-request-binding.ts'
import { type McpServerAuthorizeLoaderData } from '#universal/loader-data.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	createMcpServerAuthorizeConsentToken,
	verifyMcpServerAuthorizeConsentToken,
} from '#worker/mcp-client/authorize-consent.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { mcpOAuthAttemptActorFromIds } from '#worker/mcp-client/oauth-attempt.ts'
import { mcpOAuthAttemptIdentityInvalidMessage } from '#worker/mcp-client/oauth-identity.ts'
import { getMcpServerSettingById } from '#worker/mcp-client/settings-service.ts'
import { type McpServerPendingAuthorization } from '#worker/mcp-client/types.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { waitUntil } from 'cloudflare:workers'

type AuthorizeParams = { orgSlug: string; serverId: string }

const expiredFormMessage =
	'This approval form expired. Review the details and click Continue again.'

const notPendingMessage =
	'This server is not waiting for approval. Reconnect it to start a new authorization.'

type ConsentContext = {
	user: AuthenticatedAppUser
	orgSlug: string
	setting: { id: string; name: string; url: string }
	pending: McpServerPendingAuthorization | null
}

type ConsentRefusal =
	| { kind: 'signed-out' }
	| { kind: 'not-found'; title: string }
	| { kind: 'forbidden'; title: string }

export async function loadConsentContext(input: {
	env: Env
	request: Request
	params: AuthorizeParams
	user?: AuthenticatedAppUser
}): Promise<ConsentContext | ConsentRefusal> {
	const { env, request, params } = input
	const authenticated =
		input.user ??
		(await readAuthenticatedAppUser(request, env, {
			// Authenticate the person first; params below own resource authorization.
			resourceRequest: new Request(new URL('/', request.url)),
		}))
	if (!authenticated) return { kind: 'signed-out' }
	const resolution =
		(await loadOrgBindingForSlug(
			env.APP_DB,
			authenticated.mcpUser.userId,
			params.orgSlug,
		)) ?? 'denied'
	if (
		input.user &&
		typeof resolution !== 'string' &&
		resolution.org.id !== input.user.request.org.id
	)
		return { kind: 'not-found', title: 'Organization unavailable' }
	const denial = orgSectionDenial(resolution, 'mcp-servers')
	if (denial || typeof resolution === 'string') {
		return { kind: 'not-found', title: denial ?? 'Organization unavailable' }
	}
	const user = {
		...authenticated,
		request: deriveRequestContext({
			user: authenticated.mcpUser,
			source: { kind: 'session' },
			orgBinding: resolution,
		}),
	}
	try {
		await authorize({ env, request: user.request }, 'integration:write')
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return { kind: 'forbidden', title: 'MCP server authorization unavailable' }
	}
	const ownerId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	const setting = await getMcpServerSettingById({
		env,
		userId: ownerId,
		id: params.serverId,
	})
	if (!setting) return { kind: 'not-found', title: 'MCP server not found' }
	const hub = createMcpClientHubClient({ env, userId: ownerId, waitUntil })
	const pending = await hub.readPendingAuthorization({ serverId: setting.id })
	return {
		user,
		orgSlug: resolution.org.slug ?? params.orgSlug,
		setting,
		pending,
	}
}

export function isConsentRefusal(
	value: ConsentContext | ConsentRefusal,
): value is ConsentRefusal {
	return 'kind' in value
}

function consentTokenBinding(
	context: ConsentContext,
	pending: McpServerPendingAuthorization,
) {
	return {
		personId: context.user.mcpUser.userId,
		orgId: context.user.request.org.id,
		serverId: context.setting.id,
		authorizationUrl: pending.authorizationUrl,
	}
}

export async function buildConsentLoaderData(input: {
	env: Env
	context: ConsentContext
	error?: string | null
}): Promise<McpServerAuthorizeLoaderData> {
	const { env, context } = input
	const { pending } = context
	return {
		ok: true,
		orgSlug: context.orgSlug,
		serverId: context.setting.id,
		serverName: context.setting.name,
		serverUrl: context.setting.url,
		serverHref: orgSectionRestPath(
			context.orgSlug,
			'mcp-servers',
			context.setting.id,
		),
		pending: pending
			? {
					authorizationServerHost: new URL(pending.authorizationUrl).host,
					clientMode: pending.clientMode,
					csrfToken: await createMcpServerAuthorizeConsentToken({
						secret: env.COOKIE_SECRET,
						binding: consentTokenBinding(context, pending),
					}),
				}
			: null,
		error: input.error ?? null,
	}
}

/** Shared consent read for the document and Start route. */
export async function loadMcpServerAuthorizeData(input: {
	env: Env
	request: Request
	params: AuthorizeParams
}) {
	const context = await loadConsentContext(input)
	if (isConsentRefusal(context)) return context
	return {
		kind: 'ready' as const,
		payload: await buildConsentLoaderData({ env: input.env, context }),
	}
}

export function refusalStatus(refusal: ConsentRefusal) {
	switch (refusal.kind) {
		case 'signed-out':
			return 401
		case 'not-found':
			return 404
		case 'forbidden':
			return 403
		default: {
			const exhaustive: never = refusal
			throw new Error(`Unhandled consent refusal: ${String(exhaustive)}`)
		}
	}
}
export async function continueMcpServerAuthorization({
	env,
	context,
	token,
}: {
	env: Env
	context: ConsentContext
	token: unknown
}) {
	const { pending } = context
	if (!pending) {
		return operationResult(
			{
				ok: false,
				error: notPendingMessage,
				consent: await buildConsentLoaderData({
					env,
					context,
					error: notPendingMessage,
				}),
			},
			409,
		)
	}
	const valid =
		typeof token === 'string' &&
		token.length > 0 &&
		(await verifyMcpServerAuthorizeConsentToken({
			secret: env.COOKIE_SECRET,
			token,
			binding: consentTokenBinding(context, pending),
		}))
	if (!valid) {
		return operationResult(
			{
				ok: false,
				error: expiredFormMessage,
				consent: await buildConsentLoaderData({
					env,
					context,
					error: expiredFormMessage,
				}),
			},
			403,
		)
	}
	const actor = mcpOAuthAttemptActorFromIds({
		ownerOrgId: context.user.request.org.id,
		personId: context.user.mcpUser.userId,
	})
	const bindFailedMessage = mcpOAuthAttemptIdentityInvalidMessage(
		context.setting.name,
	)
	if (!actor) {
		return operationResult(
			{
				ok: false,
				error: bindFailedMessage,
				consent: await buildConsentLoaderData({
					env,
					context,
					error: bindFailedMessage,
				}),
			},
			409,
		)
	}
	const hub = createMcpClientHubClient({
		env,
		userId: context.user.request.org.id,
	})
	const bound = await hub
		.bindOAuthAttemptActor({
			serverId: context.setting.id,
			actor,
		})
		.catch(() => ({ ok: false as const }))
	if (!bound.ok) {
		return operationResult(
			{
				ok: false,
				error: bindFailedMessage,
				consent: await buildConsentLoaderData({
					env,
					context,
					error: bindFailedMessage,
				}),
			},
			409,
		)
	}
	return operationResult({
		ok: true,
		authorizationUrl: pending.authorizationUrl,
	})
}
