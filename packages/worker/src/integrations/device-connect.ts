/**
 * Resolve + start / poll + persist for RFC 8628 device OAuth.
 *
 * Shared by `/account/secrets.json` (`device_start` / `device_poll`) and MCP
 * `integrationDeviceConnectStart` / `integrationDeviceConnectPoll`.
 */
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import {
	assertScopesAllowedForPlatformApp,
	getAvailablePlatformApp,
} from '#worker/integrations/service.ts'
import { getPlatformOauthAppClientSecret } from '#worker/integrations/platform-apps.ts'
import { type buildConnectOauthNextSteps } from '#app/connect-oauth-next-steps.ts'
import {
	persistConnectOauthTokens,
	resolveConnectClientSecret,
	type ConnectOauthHostApprovalLink,
} from '#worker/integrations/connect-oauth-persist.ts'
import {
	completeDevicePendingSession,
	loadDevicePendingSession,
	pollDeviceAuthorization,
	startDeviceAuthorization,
	type DevicePollFailure,
	type DevicePollPending,
	type DeviceStartFailure,
	type DeviceStartSuccess,
} from '#worker/integrations/device-flow.ts'
import { resolveTokenExchangeStyle } from '#worker/integrations/oauth-token-exchange.ts'

export type DeviceConnectStartInput = {
	env: Env
	request: RequestContext
	mcpUser: McpUserContext
	provider: string
	platformAppSlug?: string | null
	tokenUrl?: string | null
	apiBaseUrl?: string | null
	authorizeUrl?: string | null
	deviceAuthorizationUrl?: string | null
	clientId?: string | null
	clientSecret?: string | null
	usePkce?: boolean | null
	scopes?: Array<string>
	scopeSeparator?: string | null
	extraAuthorizeParams?: Record<string, string>
	allowedHosts?: Array<string>
	tokenExchangeStyle?: string | null
	fetchImpl?: typeof fetch
}

export type DeviceConnectStartResult = DeviceStartSuccess | DeviceStartFailure

export type DeviceConnectPollInput = {
	env: Env
	request: RequestContext
	mcpUser: McpUserContext
	sessionId: string
	fetchImpl?: typeof fetch
	nowMs?: number
}

export type DeviceConnectPollApproved = {
	ok: true
	status: 'approved'
	accessTokenSaved: true
	refreshTokenSaved: boolean
	allowedHosts: Array<string>
	hostApprovalLinks: Array<ConnectOauthHostApprovalLink>
	integrationName: string
	nextSteps: ReturnType<typeof buildConnectOauthNextSteps>
}

export type DeviceConnectPollResult =
	| DevicePollPending
	| DeviceConnectPollApproved
	| DevicePollFailure
	| { ok: false; status: 'persist_failed'; error: string; httpStatus: number }

export async function startIntegrationDeviceConnect(
	input: DeviceConnectStartInput,
): Promise<DeviceConnectStartResult> {
	const platformAppSlug = input.platformAppSlug?.trim() || null
	const platformApp = platformAppSlug
		? await getAvailablePlatformApp({
				env: input.env,
				slug: platformAppSlug,
			})
		: null
	if (platformAppSlug && !platformApp) {
		return {
			ok: false,
			error: 'Platform integration is not available.',
			status: 400,
		}
	}

	const provider = input.provider.trim()
	const tokenUrl = platformApp
		? platformApp.tokenUrl
		: input.tokenUrl?.trim() || null
	const apiBaseUrl = platformApp
		? platformApp.apiBaseUrl
		: input.apiBaseUrl?.trim() || null
	const authorizeUrl = platformApp
		? platformApp.authorizeUrl || null
		: input.authorizeUrl?.trim() || null
	const deviceAuthorizationUrl = platformApp
		? platformApp.deviceAuthorizationUrl
		: input.deviceAuthorizationUrl?.trim() || null
	const clientId = platformApp
		? platformApp.clientId
		: input.clientId?.trim() || null
	const usePkce = platformApp ? platformApp.usePkce : (input.usePkce ?? null)
	const scopes = input.scopes ?? []
	const scopeSeparator = platformApp
		? platformApp.scopeSeparator
		: (input.scopeSeparator ?? null)
	const extraAuthorizeParams = platformApp
		? platformApp.extraAuthorizeParams
		: (input.extraAuthorizeParams ?? {})
	const allowedHosts = normalizeAllowedHosts(
		platformApp
			? [
					...platformApp.requiredHosts,
					...(platformApp.apiBaseUrl
						? [safeParseHost(platformApp.apiBaseUrl) ?? '']
						: []),
				]
			: (input.allowedHosts ?? []),
	)

	if (!provider) {
		return { ok: false, error: 'Provider is required.', status: 400 }
	}
	if (!tokenUrl) {
		return { ok: false, error: 'Token URL is required.', status: 400 }
	}
	if (!clientId) {
		return { ok: false, error: 'Client ID is required.', status: 400 }
	}
	if (!deviceAuthorizationUrl) {
		return {
			ok: false,
			error: 'Device authorization URL is required.',
			status: 400,
		}
	}
	if (platformApp) {
		try {
			assertScopesAllowedForPlatformApp(platformApp, scopes)
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
	let clientSecret: string | null = null
	if (platformApp) {
		clientSecret = await getPlatformOauthAppClientSecret({
			db: input.env.APP_DB,
			env: input.env,
			slug: platformApp.slug,
		})
	} else {
		clientSecret = await resolveConnectClientSecret({
			env: input.env,
			userId: ownerId,
			provider,
			clientSecret: input.clientSecret,
		})
	}

	return startDeviceAuthorization({
		env: input.env,
		userId: ownerId,
		deviceAuthorizationUrl,
		tokenUrl,
		apiBaseUrl: apiBaseUrl ?? null,
		authorizeUrl,
		clientId,
		clientSecret,
		scopes,
		scopeSeparator,
		extraAuthorizeParams,
		allowedHosts,
		provider,
		platformAppSlug: platformApp?.slug ?? null,
		usePkce: usePkce ?? null,
		tokenExchangeStyle: resolveTokenExchangeStyle({
			tokenUrl,
			tokenExchangeStyle: platformApp
				? platformApp.tokenExchangeStyle
				: (input.tokenExchangeStyle ?? null),
		}),
		fetchImpl: input.fetchImpl,
	})
}

export async function pollIntegrationDeviceConnect(
	input: DeviceConnectPollInput,
): Promise<DeviceConnectPollResult> {
	const sessionId = input.sessionId.trim()
	if (!sessionId) {
		return {
			ok: false,
			status: 'invalid_session',
			error: 'Session id is required.',
			httpStatus: 400,
		}
	}
	const ownerId = ownerIdFromCaller({
		request: input.request,
		user: input.mcpUser,
	})

	// Completion receipt: persist already succeeded; a lost response retries here.
	const existing = await loadDevicePendingSession({
		env: input.env,
		userId: ownerId,
		sessionId,
	})
	if (existing?.completion) {
		return {
			ok: true,
			status: 'approved',
			accessTokenSaved: true,
			refreshTokenSaved: existing.completion.refreshTokenSaved,
			allowedHosts: existing.completion.allowedHosts,
			hostApprovalLinks: existing.completion.hostApprovalLinks,
			integrationName: existing.completion.integrationName,
			nextSteps: existing.completion
				.nextSteps as DeviceConnectPollApproved['nextSteps'],
		}
	}

	const polled = await pollDeviceAuthorization({
		env: input.env,
		userId: ownerId,
		sessionId,
		fetchImpl: input.fetchImpl,
		nowMs: input.nowMs,
	})
	if (!polled.ok) return polled
	if (polled.status !== 'approved') {
		return polled
	}

	const platformApp = polled.session.platformAppSlug
		? await getAvailablePlatformApp({
				env: input.env,
				slug: polled.session.platformAppSlug,
			})
		: null
	if (polled.session.platformAppSlug && !platformApp) {
		return {
			ok: false,
			status: 'persist_failed',
			error: 'Platform integration is not available.',
			httpStatus: 400,
		}
	}

	const persisted = await persistConnectOauthTokens({
		env: input.env,
		request: input.request,
		mcpUser: input.mcpUser,
		provider: polled.session.provider,
		platformApp,
		tokenUrl: polled.session.tokenUrl,
		apiBaseUrl: polled.session.apiBaseUrl,
		authorizeUrl: polled.session.authorizeUrl,
		deviceAuthorizationUrl: polled.session.deviceAuthorizationUrl,
		flow: 'device',
		usePkce: polled.session.usePkce,
		clientId: polled.session.clientId,
		tokenExchangeStyle: polled.session.tokenExchangeStyle,
		allowedHosts: polled.session.allowedHosts,
		scopes: polled.session.scopes,
		scopeSeparator: polled.session.scopeSeparator,
		extraAuthorizeParams: polled.session.extraAuthorizeParams,
		tokenRecord: polled.tokenPayload,
		clientSecret: polled.clientSecret,
	})
	if (!persisted.ok) {
		// Leave the approved session in KV so a retry poll can re-read tokens.
		return {
			ok: false,
			status: 'persist_failed',
			error: persisted.error,
			httpStatus: persisted.status,
		}
	}
	const approved: DeviceConnectPollApproved = {
		ok: true,
		status: 'approved',
		accessTokenSaved: true,
		refreshTokenSaved: persisted.refreshTokenSaved,
		allowedHosts: persisted.allowedHosts,
		hostApprovalLinks: persisted.hostApprovalLinks,
		integrationName: persisted.integrationName,
		nextSteps: persisted.nextSteps,
	}
	await completeDevicePendingSession({
		env: input.env,
		userId: ownerId,
		sessionId,
		completion: {
			refreshTokenSaved: approved.refreshTokenSaved,
			allowedHosts: approved.allowedHosts,
			hostApprovalLinks: approved.hostApprovalLinks,
			integrationName: approved.integrationName,
			nextSteps: approved.nextSteps,
		},
	})
	return approved
}
