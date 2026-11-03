/**
 * Shared post-token path for authorization_code connect and device poll
 * success. Scope validation, upsert, token persist (ADR 0052), optional BYO
 * client-secret store, and auth.succeeded events.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { waitUntil } from 'cloudflare:workers'
import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	orgAuditWriterFromRequest,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { buildConnectOauthNextSteps } from '#worker/integrations/connect-oauth-next-steps.ts'
import {
	canonicalIntegrationName,
	normalizeIntegrationConfig,
	integrationConfigSchema,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	assertScopesAllowedForPlatformApp,
	getJoinedIntegration,
	upsertIntegration,
	upsertPlatformIntegration,
	type LiveConnectionGuard,
} from '#worker/integrations/service.ts'
import type { PlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import { listOauthAppsByTokenEndpoint } from '#worker/integrations/repo.ts'
import {
	persistIntegrationTokens,
	persistUserOauthAppClientSecret,
	resolveUserOauthAppClientSecret,
} from '#worker/integrations/credentials.ts'
import { dispatchIntegrationAuthSucceededSubscriptionEvents } from '#worker/integrations/package-subscriptions.ts'
import { inferIntegrationRefreshPolicy } from '#worker/integrations/refresh-policy.ts'
import {
	resolveTokenExchangeStyle,
	type TokenExchangeStyle,
} from '#worker/integrations/oauth-token-exchange.ts'

export type ConnectOauthHostApprovalLink = {
	secretName: string
	host: string
	approvalUrl: string
}

export type PersistConnectOauthTokensInput = {
	env: Env
	request: RequestContext
	mcpUser: McpUserContext
	provider: string
	platformApp: PlatformOauthApp | null
	tokenUrl: string
	apiBaseUrl: string | null
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	flow: 'pkce' | 'confidential' | 'device'
	usePkce: boolean | null
	clientId: string
	tokenExchangeStyle: string | null
	allowedHosts: Array<string>
	scopes: Array<string>
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	tokenRecord: Record<string, unknown>
	clientSecret?: string | null
	liveConnectionGuard?: LiveConnectionGuard
}

export type PersistConnectOauthTokensResult =
	| {
			ok: true
			integrationName: string
			refreshTokenSaved: boolean
			allowedHosts: Array<string>
			hostApprovalLinks: Array<ConnectOauthHostApprovalLink>
			nextSteps: ReturnType<typeof buildConnectOauthNextSteps>
	  }
	| { ok: false; error: string; status: number }

export async function persistConnectOauthTokens(
	input: PersistConnectOauthTokensInput,
): Promise<PersistConnectOauthTokensResult> {
	const accessToken = readTokenField(input.tokenRecord, 'access_token')
	const refreshToken = readTokenField(input.tokenRecord, 'refresh_token')
	if (!accessToken) {
		return {
			ok: false,
			error: 'Token payload did not include an access_token.',
			status: 400,
		}
	}
	// Scope validation must precede token persistence: a rejected scope set
	// must not leave orphan token rows behind.
	if (input.platformApp) {
		try {
			assertScopesAllowedForPlatformApp(input.platformApp, input.scopes)
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Requested scopes are not allowed.',
				status: 400,
			}
		}
	}
	const ownerId = ownerIdFromCaller({
		request: input.request,
		user: input.mcpUser,
	})
	let integrationName: string
	try {
		integrationName = input.platformApp
			? (
					await upsertPlatformIntegration({
						env: input.env,
						userId: ownerId,
						platformAppSlug: input.platformApp.slug,
						name: input.provider,
						scopes: input.scopes,
						audit: orgAuditWriterFromRequest(input.env, input.request),
					})
				).name
			: await saveIntegrationConfig({
					env: input.env,
					userId: ownerId,
					provider: input.provider,
					tokenUrl: input.tokenUrl,
					apiBaseUrl: input.apiBaseUrl,
					flow: input.flow,
					usePkce: input.usePkce,
					clientId: input.clientId,
					tokenExchangeStyle: resolveTokenExchangeStyle({
						tokenUrl: input.tokenUrl,
						tokenExchangeStyle: input.tokenExchangeStyle,
					}),
					deviceAuthorizationUrl: input.deviceAuthorizationUrl,
					allowedHosts: input.allowedHosts,
					authorization: input.authorizeUrl
						? {
								authorizeUrl: input.authorizeUrl,
								scopes: input.scopes,
								scopeSeparator: input.scopeSeparator,
								extraAuthorizeParams: input.extraAuthorizeParams,
							}
						: null,
					audit: orgAuditWriterFromRequest(input.env, input.request),
					liveConnectionGuard: input.liveConnectionGuard,
				})
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: 'Unable to save OAuth connection.',
			status: 400,
		}
	}
	await persistIntegrationTokens({
		env: input.env,
		userId: ownerId,
		name: integrationName,
		accessToken,
		refreshToken,
		refreshPolicy: inferIntegrationRefreshPolicy(input.tokenRecord),
		audit: orgAuditWriterFromRequest(input.env, input.request),
	})
	const connected = await getJoinedIntegration({
		env: input.env,
		userId: ownerId,
		name: integrationName,
	})
	if (!input.platformApp && connected?.lane === 'user') {
		const clientSecret = await resolveTokenEndpointClientSecret({
			env: input.env,
			userId: ownerId,
			provider: integrationName,
			clientId: connected.app.clientId,
			tokenUrl: connected.app.tokenUrl,
			clientSecret: input.clientSecret,
		})
		if (clientSecret) {
			await persistUserOauthAppClientSecret({
				env: input.env,
				userId: ownerId,
				slug: connected.app.slug,
				value: clientSecret,
			})
		}
	}
	const hostApprovalLinks: Array<ConnectOauthHostApprovalLink> = []
	const nextSteps = buildConnectOauthNextSteps({
		integrationName,
		integration: {
			name: integrationName,
			tokenUrl: input.tokenUrl,
			apiBaseUrl: input.apiBaseUrl,
			requiredHosts: input.allowedHosts,
			authorization: input.authorizeUrl
				? {
						authorizeUrl: input.authorizeUrl,
						scopes: input.scopes,
					}
				: null,
		},
	})

	await emitConnectOauthAuthSucceeded({
		env: input.env,
		userId: ownerId,
		integration: {
			name: integrationName,
			lane: input.platformApp ? 'platform' : 'user',
			account_label: connected?.connection.accountLabel ?? null,
			description: connected?.connection.description ?? null,
			provider: input.platformApp?.provider ?? null,
			platform_app_slug: input.platformApp?.slug ?? null,
			scopes: input.scopes,
			connected_at: connected?.connection.connectedAt ?? null,
			token_refreshed_at: connected?.connection.tokenRefreshedAt ?? null,
		},
	})

	return {
		ok: true,
		integrationName,
		refreshTokenSaved: Boolean(refreshToken),
		allowedHosts: input.allowedHosts,
		hostApprovalLinks,
		nextSteps,
	}
}

/**
 * The stored secret for a token exchange the caller describes. A stored
 * secret only goes to its own app's token URL with its own client id, so a
 * request naming a provider cannot send that app's secret elsewhere. Matching
 * on the endpoint also finds an app reused under another provider name.
 */
export async function resolveTokenEndpointClientSecret(input: {
	env: Env
	userId: OwnerId
	provider: string
	clientId: string | null
	tokenUrl: string
	clientSecret?: string | null
}): Promise<string | null> {
	const inline = input.clientSecret?.trim()
	if (inline) return inline
	const clientId = input.clientId?.trim()
	const tokenUrl = input.tokenUrl.trim()
	if (!clientId || !tokenUrl) return null
	const apps = await listOauthAppsByTokenEndpoint({
		db: input.env.APP_DB,
		userId: input.userId,
		clientId,
		tokenUrl,
	})
	const preferred = canonicalIntegrationName(input.provider)
	apps.sort(
		(a, b) => Number(b.slug === preferred) - Number(a.slug === preferred),
	)
	for (const app of apps) {
		const fromApp = await resolveUserOauthAppClientSecret({
			env: input.env,
			userId: input.userId,
			slug: app.slug,
		})
		if (fromApp) return fromApp
	}
	return null
}

async function saveIntegrationConfig(input: {
	env: Env
	userId: OwnerId
	provider: string
	tokenUrl: string
	apiBaseUrl: string | null
	flow: 'pkce' | 'confidential' | 'device'
	usePkce: boolean | null
	clientId: string
	tokenExchangeStyle: TokenExchangeStyle | null
	deviceAuthorizationUrl?: string | null
	allowedHosts: Array<string>
	authorization: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator: string | null
		extraAuthorizeParams: Record<string, string>
	} | null
	audit: OrgAuditWriter | null
	liveConnectionGuard?: LiveConnectionGuard
}) {
	const providerKey = canonicalIntegrationName(input.provider)
	if (!providerKey) {
		throw new Error('Provider must contain letters or numbers.')
	}
	const parsed = integrationConfigSchema.safeParse({
		name: input.provider,
		tokenUrl: input.tokenUrl,
		apiBaseUrl: input.apiBaseUrl,
		flow: input.flow,
		...(input.usePkce == null ? {} : { usePkce: input.usePkce }),
		clientId: input.clientId,
		requiredHosts: input.allowedHosts,
		...(input.tokenExchangeStyle && input.tokenExchangeStyle !== 'form'
			? { tokenExchangeStyle: input.tokenExchangeStyle }
			: {}),
		...(input.deviceAuthorizationUrl
			? { deviceAuthorizationUrl: input.deviceAuthorizationUrl }
			: {}),
		...(input.authorization ? { authorization: input.authorization } : {}),
	})
	if (!parsed.success) {
		throw new Error('OAuth integration configuration is invalid.')
	}
	const integration = await upsertIntegration({
		env: input.env,
		userId: input.userId,
		config: normalizeIntegrationConfig(parsed.data),
		waitUntil,
		audit: input.audit,
		liveConnectionGuard: input.liveConnectionGuard,
	})
	return integration.name
}

export async function emitConnectOauthAuthSucceeded(input: {
	env: Env
	userId: OwnerId
	integration: {
		name: string
		lane: 'user' | 'platform'
		account_label: string | null
		description: string | null
		provider: string | null
		platform_app_slug: string | null
		scopes: Array<string>
		connected_at: string | null
		token_refreshed_at: string | null
	}
}) {
	try {
		await dispatchIntegrationAuthSucceededSubscriptionEvents({
			env: input.env,
			userId: input.userId,
			eventId: crypto.randomUUID(),
			occurredAt: new Date().toISOString(),
			integration: input.integration,
			source: 'oauth_connect',
		})
	} catch (error) {
		console.warn(
			'integration.auth.succeeded package subscription dispatch failed',
			{
				integrationName: input.integration.name,
				error,
			},
		)
	}
}

function readTokenField(
	payload: Record<string, unknown>,
	field: string,
): string | null {
	const value = payload[field]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}
