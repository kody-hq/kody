import { buildMcpServerAuthorizeUrl } from '#worker/mcp-client/authorize-consent.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import {
	mcpOAuthReturnCookie,
	readMcpOAuthReturnCookie,
} from '#universal/mcp-oauth-return.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { routes } from '#universal/routes.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { mcpOAuthAttemptActorFromIds } from '#worker/mcp-client/oauth-attempt.ts'
import { enrichMcpOAuthProviderError } from '#worker/mcp-client/oauth-provider-error.ts'
import { extractMcpServerIdFromOAuthState } from '#worker/mcp-client/oauth-state.ts'
import { normalizeMcpPreRegisteredOAuthClientInput } from '#worker/mcp-client/preregistered-oauth-client.ts'
import { getMcpServerOwnerId } from '#worker/mcp-client/settings-repo.ts'
import {
	addMcpServer,
	deleteMcpServer,
	getMcpServerSettingById,
	resolveMcpServerOAuthClientUrls,
	setMcpServerEnabled,
	setMcpServerLastError,
	setMcpServerPreRegisteredOAuthClient,
	setMcpServerUsage,
} from '#worker/mcp-client/settings-service.ts'
import {
	type McpServerConnectResult,
	type McpServerLastError,
} from '#worker/mcp-client/types.ts'
import {
	orgAuditWriterFromRequest,
	recordOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { waitUntil } from 'cloudflare:workers'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

/**
 * The request to finish an MCP OAuth callback as. The callback URL has no
 * org, so the session binds the person's signup org; the pending state lives
 * in the hub of the org that owns the server named in `state`. That org is
 * used when the person can write its integrations, the same check the
 * consent page made before sending them to the provider. Rejects when the
 * person cannot, so the caller falls back to the session request.
 */
async function callbackRequestForServer(input: {
	env: Env
	url: URL
	user: AuthenticatedUser
}): Promise<RequestContext> {
	const fallback = input.user.request
	const serverId = extractMcpServerIdFromOAuthState(
		input.url.searchParams.get('state'),
	)
	if (!serverId) return fallback
	const ownerId = await getMcpServerOwnerId({
		db: input.env.APP_DB,
		id: serverId,
	})
	if (!ownerId || ownerId === fallback.org.id) return fallback
	const orgBinding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		ownerId,
	)
	if (!orgBinding) return fallback
	const request = deriveRequestContext({
		user: input.user.mcpUser,
		source: { kind: 'session' },
		orgBinding,
	})
	await authorize({ env: input.env, request }, 'integration:write')
	return request
}

/**
 * Completes the OAuth authorization redirect from a remote MCP server. The
 * browser session cookie identifies the user; the hub of the org that owns
 * the server holds the pending OAuth state matching the `state` parameter.
 */
export function createAccountMcpServersOauthCallbackHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		if (request.method === 'HEAD') {
			return new Response(null, { status: 200 })
		}

		const user = await requireAuthenticatedPageUser(request, env)
		if (user instanceof Response) {
			return user
		}

		const callbackRequest = await callbackRequestForServer({
			env,
			url: new URL(request.url),
			user,
		}).catch(() => user.request)
		const ownerId = ownerIdFromCaller({
			request: callbackRequest,
			user: user.mcpUser,
		})
		const hub = createMcpClientHubClient({
			env,
			userId: ownerId,
			waitUntil,
		})
		let authSuccess = false
		let authError: string | null = null
		let serverName: string | null = null
		let serverId: string | null = null
		let authorizationNeeded = false
		let lastError: McpServerLastError | null = null
		const oauth = resolveMcpServerOAuthClientUrls({
			env,
			requestUrl: request.url,
		})
		try {
			const outcome = await hub.handleOAuthCallback({
				url: request.url,
				callbackUrl: oauth.callbackUrl,
				actor: mcpOAuthAttemptActorFromIds({
					ownerOrgId: ownerId,
					personId: user.mcpUser.userId,
				}),
			})
			authSuccess = outcome.authSuccess
			authError = outcome.authError
			serverName = outcome.serverName
			serverId = outcome.serverId
			authorizationNeeded = outcome.authorizationNeeded
			lastError = outcome.lastError
		} catch (error) {
			authError = getErrorMessage(error)
		}

		if (authError) {
			authError = enrichMcpOAuthProviderError(authError, oauth)
			if (lastError) lastError = { ...lastError, message: authError }
		}

		if (serverId && authSuccess && !lastError) {
			await setMcpServerLastError({
				env,
				userId: ownerId,
				id: serverId,
				lastError: null,
			}).catch(() => {})
		} else if (serverId && lastError) {
			await setMcpServerLastError({
				env,
				userId: ownerId,
				id: serverId,
				lastError,
			}).catch(() => {})
		}

		const returnToOnboarding =
			readMcpOAuthReturnCookie(request.headers.get('Cookie')) != null
		const orgSlug = callbackRequest.org.slug?.trim() || user.username
		const target = returnToOnboarding
			? new URL(routes.onboardingStep2.href(), request.url)
			: new URL(
					orgSectionRestPath(orgSlug, 'mcp-servers', serverId ? serverId : ''),
					request.url,
				)
		if (authorizationNeeded) {
			target.searchParams.set('auth', serverId ? 'required' : 'retry')
		} else if (authSuccess) {
			target.searchParams.set('auth', 'success')
			if (serverName) {
				target.searchParams.set('server', serverName)
			}
		} else {
			target.searchParams.set('auth', 'error')
			target.searchParams.set('reason', authError ?? 'Authorization failed.')
		}
		const headers = new Headers({ Location: target.toString() })
		if (returnToOnboarding) {
			headers.append(
				'Set-Cookie',
				mcpOAuthReturnCookie({
					value: '',
					secure: new URL(request.url).protocol === 'https:',
				}),
			)
		}
		return new Response(null, { status: 303, headers })
	}
}

async function handleAddAction(input: {
	env: Env
	user: AuthenticatedUser
	name: string
	url: string
	bearerToken?: string
	request: Request
}) {
	const oauth = resolveMcpServerOAuthClientUrls({
		env: input.env,
		requestUrl: input.request.url,
	})
	const { setting, connection } = await addMcpServer({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		personId: input.user.mcpUser.userId,
		name: input.name.trim(),
		url: input.url.trim(),
		baseUrl: oauth.clientOrigin,
		bearerToken: input.bearerToken?.trim() || undefined,
		waitUntil,
	})
	return operationResult(connectionOutcome(input, setting, connection))
}

async function handleConnectionAction(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	request: Request
	kind: 'reconnect' | 'refresh'
}) {
	const setting = await requireSetting(input)
	const ownerOrgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const actor = mcpOAuthAttemptActorFromIds({
		ownerOrgId,
		personId: input.user.mcpUser.userId,
	})
	const hub = createMcpClientHubClient({
		env: input.env,
		userId: ownerOrgId,
		waitUntil,
	})
	const result =
		input.kind === 'reconnect'
			? await hub.reconnectServer({
					serverId: setting.id,
					actor,
					callbackUrl: resolveMcpServerOAuthClientUrls({
						env: input.env,
						requestUrl: input.request.url,
					}).callbackUrl,
				})
			: await hub.refreshServer({ serverId: setting.id })
	if (result.state === 'ready') {
		await setMcpServerLastError({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			id: setting.id,
			lastError: null,
		}).catch(() => {})
	} else if (result.lastError) {
		await setMcpServerLastError({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			id: setting.id,
			lastError: result.lastError,
		}).catch(() => {})
	}
	return operationResult(connectionOutcome(input, setting, result))
}

async function handleSetEnabledAction(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	enabled: boolean
	request: Request
}) {
	const setting = await requireSetting(input)
	const updated = await setMcpServerEnabled({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		id: setting.id,
		enabled: input.enabled,
	})
	return operationResult({ ok: true, selectedServerId: updated.id })
}

async function handleSetUsageAction(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	usageMode: 'any' | 'packages'
	allowedPackageIds: string[]
	request: Request
}) {
	const setting = await requireSetting(input)
	const usageMode = input.usageMode.trim()
	if (usageMode !== 'any' && usageMode !== 'packages') {
		throw new Error('Usage must be any or packages.')
	}
	const allowedPackageIds =
		usageMode === 'packages' ? input.allowedPackageIds : []
	const updated = await setMcpServerUsage({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		id: setting.id,
		usageMode,
		allowedPackageIds,
	})
	return operationResult({ ok: true, selectedServerId: updated.id })
}

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	request: Request
}) {
	const setting = await requireSetting(input)
	const deleted = await deleteMcpServer({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		id: setting.id,
	})
	if (!deleted) {
		return operationResult({ ok: false, error: 'MCP server not found.' }, 404)
	}
	return operationResult({ ok: true, deletedServerId: setting.id })
}

/**
 * Save, replace, or remove a server's pre-registered OAuth client. Only this
 * settings page can do it; no capability takes a client secret. The secret
 * is never echoed: responses carry the client id alone.
 */
async function handleOAuthClientAction(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	clientId?: string
	clientSecret?: string
	request: Request
	kind: 'set' | 'remove'
}) {
	await authorize(
		{ env: input.env, request: input.user.request },
		'integration:write',
	)
	const setting = await requireSetting(input)
	let client: { clientId: string; clientSecret: string } | null = null
	if (input.kind === 'set') {
		const parsed = normalizeMcpPreRegisteredOAuthClientInput({
			clientId: input.clientId,
			clientSecret: input.clientSecret,
		})
		if (!parsed.ok) {
			return operationResult({ ok: false, error: parsed.error }, 400)
		}
		client = { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
	}
	const change = await setMcpServerPreRegisteredOAuthClient({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		personId: input.user.mcpUser.userId,
		id: setting.id,
		callbackUrl: resolveMcpServerOAuthClientUrls({
			env: input.env,
			requestUrl: input.request.url,
		}).callbackUrl,
		client,
	})
	if (!change.changed) {
		return operationResult(
			{ ok: false, error: 'This server has no OAuth client configured.' },
			400,
		)
	}
	await recordOrgAuditEvent(
		orgAuditWriterFromRequest(input.env, input.user.request),
		{
			orgId: input.user.request.org.id,
			action: client
				? change.previousClientId
					? 'mcp_server.oauth_client_replaced'
					: 'mcp_server.oauth_client_set'
				: 'mcp_server.oauth_client_removed',
			resourceType: 'mcp_server',
			resourceId: setting.id,
			details: {
				serverName: setting.name,
				clientId: client?.clientId ?? change.previousClientId,
			},
		},
	)
	return operationResult({
		...connectionOutcome(input, setting, change.connection),
		oauthClientId: client?.clientId ?? null,
	})
}

async function requireSetting(input: {
	env: Env
	user: AuthenticatedUser
	id: string
}) {
	const id = input.id.trim()
	if (!id) {
		throw new Error('MCP server id is required.')
	}
	const setting = await getMcpServerSettingById({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		id,
	})
	if (!setting) {
		throw new Error('MCP server not found.')
	}
	return setting
}

async function mcpSettingsOperation<T>(run: () => Promise<T>) {
	try {
		return await run()
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to update MCP server settings.',
			},
			error instanceof AuthorizationError ? 403 : 400,
		)
	}
}

export function addAccountMcpServer(
	input: Parameters<typeof handleAddAction>[0],
) {
	return mcpSettingsOperation(() => handleAddAction({ ...input }))
}

export function reconnectAccountMcpServer(
	input: Omit<Parameters<typeof handleConnectionAction>[0], 'kind'>,
) {
	return mcpSettingsOperation(() =>
		handleConnectionAction({ ...input, kind: 'reconnect' }),
	)
}

export function refreshAccountMcpServer(
	input: Omit<Parameters<typeof handleConnectionAction>[0], 'kind'>,
) {
	return mcpSettingsOperation(() =>
		handleConnectionAction({ ...input, kind: 'refresh' }),
	)
}

export function setAccountMcpServerEnabled(
	input: Parameters<typeof handleSetEnabledAction>[0],
) {
	return mcpSettingsOperation(() => handleSetEnabledAction({ ...input }))
}

export function setAccountMcpServerUsage(
	input: Parameters<typeof handleSetUsageAction>[0],
) {
	return mcpSettingsOperation(() => handleSetUsageAction({ ...input }))
}

export function deleteAccountMcpServer(
	input: Parameters<typeof handleDeleteAction>[0],
) {
	return mcpSettingsOperation(() => handleDeleteAction({ ...input }))
}

export function setAccountMcpServerOAuthClient(
	input: Omit<Parameters<typeof handleOAuthClientAction>[0], 'kind'>,
) {
	return mcpSettingsOperation(() =>
		handleOAuthClientAction({ ...input, kind: 'set' }),
	)
}

export function removeAccountMcpServerOAuthClient(
	input: Omit<Parameters<typeof handleOAuthClientAction>[0], 'kind'>,
) {
	return mcpSettingsOperation(() =>
		handleOAuthClientAction({ ...input, kind: 'remove' }),
	)
}

function connectionOutcome(
	input: { env: Env; request: Request; user: AuthenticatedUser },
	setting: { id: string; name: string },
	connection: McpServerConnectResult,
) {
	const oauth = resolveMcpServerOAuthClientUrls({
		env: input.env,
		requestUrl: input.request.url,
	})
	return {
		ok: true as const,
		selectedServerId: setting.id,
		name: setting.name,
		state: connection.state,
		toolCount: connection.toolCount,
		error: connection.error,
		authUrl: connection.authorizationPending
			? buildMcpServerAuthorizeUrl({
					appOrigin: oauth.clientOrigin,
					orgSlug: input.user.request.org.slug?.trim() || input.user.username,
					serverId: setting.id,
				})
			: null,
	}
}
