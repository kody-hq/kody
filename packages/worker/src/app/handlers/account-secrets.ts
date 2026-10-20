import {
	type SaveSecretInput,
	type SaveOAuthAppInput,
	type ConnectOAuthInput,
	type ExchangeOAuthTokenInput,
} from '#universal/secret-mutations.ts'
import {
	getSecretContextForAccountSecret,
	listAccountSecrets,
	type loadAccountSecretsSelection,
	resolveApprovalRequest,
	toPackageOptions,
} from '#app/account-secrets-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { buildConnectOauthNextSteps } from '#worker/integrations/connect-oauth-next-steps.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	canonicalIntegrationName,
	integrationConfigSchema,
	normalizeIntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	planOptInCredentialFieldsForOrg,
	withCredentialAudit,
} from '#mcp/capabilities/secrets/secret-set-opt-in.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { normalizeAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import { classifyBulkApprovalHosts } from '#mcp/secrets/host-approval.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { filterValidApprovalHosts } from '#mcp/secrets/approval-host-shape.ts'
import { normalizeBulkPackageSecretApprovalNames } from '#mcp/secrets/package-approval-url.ts'
import {
	deleteSecret,
	findSecret,
	listSecrets,
	renameSecret,
	resolveSecret,
	saveSecret,
	type SaveSecretCredential,
	setSecretAllowedHosts,
	setSecretAllowedPackages,
} from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import {
	credentialHostsSchema,
	credentialProviderSchema,
	loginExchangeSchema,
	optInStoredCredentialKinds,
	readStoredCredentialPlacement,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import {
	credentialFillPlacementSchema,
	serializeCredentialFillPlacement,
	type CredentialFillPlacement,
} from '#worker/credentials/fill-placement.ts'
import { type LoginExchange } from '#worker/credentials/login-resolver.ts'
import {
	persistIntegrationTokens,
	persistUserOauthAppClientSecret,
	resolveUserOauthAppClientSecret,
} from '#worker/integrations/credentials.ts'
import {
	pollIntegrationDeviceConnect,
	startIntegrationDeviceConnect,
} from '#worker/integrations/device-connect.ts'
import {
	buildOAuthTokenExchangeFailurePayload,
	buildOAuthTokenExchangeRequest,
	isOAuthTokenExchangeSoftFailure,
	normalizeOAuthTokenExchangePayload,
	oauthTokenExchangeFailureHttpStatus,
	resolveTokenExchangeStyle,
	type TokenExchangeStyle,
} from '#worker/integrations/oauth-token-exchange.ts'
import { dispatchIntegrationAuthSucceededSubscriptionEvents } from '#worker/integrations/package-subscriptions.ts'
import { getPlatformOauthAppClientSecret } from '#worker/integrations/platform-apps.ts'
import { inferIntegrationRefreshPolicy } from '#worker/integrations/refresh-policy.ts'
import {
	assertSafeDeviceAuthorizationUrl,
	assertSafeTokenUrl,
} from '#worker/integrations/device-flow.ts'
import {
	assertScopesAllowedForPlatformApp,
	findOauthAppForProviderSetup,
	getAvailablePlatformApp,
	getJoinedIntegration,
	upsertIntegration,
	upsertOauthAppWithoutConnection,
	upsertPlatformIntegration,
} from '#worker/integrations/service.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	buildAccountSecretId,
	parseAccountSecretId,
} from '@kody-internal/shared/account-secret-route.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { normalizeSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { waitUntil } from 'cloudflare:workers'
import { z } from 'zod'

type AccountEditableSecretScope = Extract<SecretScope, 'package' | 'user'>

type SavedPackageOption = {
	id: string
	title: string
	updatedAt: string
}

type SecretApprovalAction = 'approve' | 'reject'

type SecretRefresh = Pick<
	Parameters<typeof loadAccountSecretsSelection>[0],
	'selectedSecretId' | 'approval'
>

export async function saveAccountOAuthApp(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: SaveOAuthAppInput
}) {
	const provider = input.fields.provider?.trim() || null
	const tokenUrl = input.fields.tokenUrl?.trim() ?? null
	const apiBaseUrl = input.fields.apiBaseUrl?.trim() ?? null
	const authorizeUrl = input.fields.authorizeUrl?.trim() ?? null
	const deviceAuthorizationUrl =
		input.fields.deviceAuthorizationUrl?.trim() ?? null
	const flow = input.fields.flow?.trim() ?? null
	const usePkce = input.fields.usePkce ?? null
	const clientId = input.fields.clientId?.trim() ?? null
	const scopeSeparator = input.fields.scopeSeparator ?? null
	const extraAuthorizeParams = input.fields.extraAuthorizeParams ?? {}

	if (!provider) {
		return operationResult({ ok: false, error: 'Provider is required.' }, 400)
	}
	if (!tokenUrl) {
		return operationResult({ ok: false, error: 'Token URL is required.' }, 400)
	}
	const tokenUrlError = assertSafeTokenUrl(tokenUrl)
	if (tokenUrlError) {
		return operationResult({ ok: false, error: tokenUrlError }, 400)
	}
	if (!clientId) {
		return operationResult({ ok: false, error: 'Client ID is required.' }, 400)
	}
	if (flow && flow !== 'pkce' && flow !== 'confidential' && flow !== 'device') {
		return operationResult({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}
	const resolvedFlow =
		flow === 'confidential' || flow === 'device' ? flow : 'pkce'
	if (resolvedFlow === 'device' && !deviceAuthorizationUrl) {
		return operationResult(
			{ ok: false, error: 'Device authorization URL is required.' },
			400,
		)
	}
	if (authorizeUrl) {
		const authorizeHost = safeParseHost(authorizeUrl)
		if (!authorizeHost) {
			return operationResult(
				{ ok: false, error: 'Authorize URL is invalid.' },
				400,
			)
		}
	}
	if (deviceAuthorizationUrl) {
		const deviceUrlError = assertSafeDeviceAuthorizationUrl(
			deviceAuthorizationUrl,
		)
		if (deviceUrlError) {
			return operationResult({ ok: false, error: deviceUrlError }, 400)
		}
		const deviceHost = safeParseHost(deviceAuthorizationUrl)
		if (!deviceHost) {
			return operationResult(
				{ ok: false, error: 'Device authorization URL is invalid.' },
				400,
			)
		}
	}

	try {
		const app = await upsertOauthAppWithoutConnection({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			waitUntil,
			config: {
				name: provider,
				tokenUrl,
				apiBaseUrl,
				flow: resolvedFlow,
				...(usePkce == null ? {} : { usePkce }),
				clientId,
				tokenExchangeStyle: resolveTokenExchangeStyle({
					tokenUrl,
					tokenExchangeStyle: input.fields.tokenExchangeStyle?.trim() ?? null,
				}),
				...(deviceAuthorizationUrl ? { deviceAuthorizationUrl } : {}),
				authorization: authorizeUrl
					? {
							authorizeUrl,
							scopes: [],
							scopeSeparator,
							extraAuthorizeParams,
						}
					: null,
			},
		})
		const clientSecret = await resolveConnectClientSecret({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			provider,
			clientSecret: input.fields.clientSecret?.trim() ?? null,
		})
		if (clientSecret) {
			await persistUserOauthAppClientSecret({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				slug: app.slug,
				value: clientSecret,
			})
		}
		return operationResult({
			ok: true,
			app: {
				slug: app.slug,
				provider: app.provider,
				clientId: app.clientId,
				hasClientSecret: Boolean(clientSecret) || app.hasClientSecret,
				tokenUrl: app.tokenUrl,
				authorizeUrl: app.authorizeUrl,
				deviceAuthorizationUrl: app.deviceAuthorizationUrl,
				apiBaseUrl: app.apiBaseUrl,
				flow: app.flow,
				usePkce: app.usePkce,
				tokenExchangeStyle: app.tokenExchangeStyle,
			},
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to save OAuth app configuration.',
			},
			400,
		)
	}
}

export async function connectAccountOAuth(input: {
	request: Request
	refresh: SecretRefresh
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: ConnectOAuthInput
}) {
	const provider = input.fields.provider?.trim() || null
	const platformAppSlug = input.fields.platformAppSlug?.trim() ?? null
	const platformApp = platformAppSlug
		? await getAvailablePlatformApp({ env: input.env, slug: platformAppSlug })
		: null
	if (platformAppSlug && !platformApp) {
		return operationResult(
			{ ok: false, error: 'Platform integration is not available.' },
			400,
		)
	}
	// Platform lane: endpoints and hosts come from the operator-provisioned
	// app row, not the request body.
	const tokenUrl = platformApp
		? platformApp.tokenUrl
		: (input.fields.tokenUrl?.trim() ?? null)
	const apiBaseUrl = platformApp
		? platformApp.apiBaseUrl
		: (input.fields.apiBaseUrl?.trim() ?? null)
	const authorizeUrl = platformApp
		? platformApp.authorizeUrl
		: (input.fields.authorizeUrl?.trim() ?? null)
	const deviceAuthorizationUrl = platformApp
		? platformApp.deviceAuthorizationUrl
		: (input.fields.deviceAuthorizationUrl?.trim() ?? null)
	const flow = platformApp
		? platformApp.flow
		: (input.fields.flow?.trim() ?? null)
	const usePkce = platformApp
		? platformApp.usePkce
		: (input.fields.usePkce ?? null)
	const clientId = platformApp
		? platformApp.clientId
		: (input.fields.clientId?.trim() ?? null)
	const allowedHosts = normalizeAllowedHosts(
		platformApp
			? [
					...platformApp.requiredHosts,
					...(platformApp.apiBaseUrl
						? [safeParseHost(platformApp.apiBaseUrl) ?? '']
						: []),
				]
			: (input.fields.allowedHosts ?? []),
	)
	const scopes = input.fields.scopes ?? []
	const scopeSeparator = input.fields.scopeSeparator ?? null
	const extraAuthorizeParams = input.fields.extraAuthorizeParams ?? {}
	const tokenPayload = input.fields.tokenPayload

	if (!provider) {
		return operationResult({ ok: false, error: 'Provider is required.' }, 400)
	}
	if (!tokenUrl) {
		return operationResult({ ok: false, error: 'Token URL is required.' }, 400)
	}
	const tokenHost = safeParseHost(tokenUrl)
	const normalizedHosts = normalizeAllowedHosts([
		...allowedHosts,
		...(tokenHost ? [tokenHost] : []),
	])
	allowedHosts.splice(0, allowedHosts.length, ...normalizedHosts)
	if (!allowedHosts.length) {
		return operationResult(
			{ ok: false, error: 'Allowed hosts are required.' },
			400,
		)
	}
	if (flow && flow !== 'pkce' && flow !== 'confidential' && flow !== 'device') {
		return operationResult({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}
	if (!clientId) {
		return operationResult({ ok: false, error: 'Client ID is required.' }, 400)
	}
	if (!tokenPayload || typeof tokenPayload !== 'object') {
		return operationResult(
			{ ok: false, error: 'Token payload is required.' },
			400,
		)
	}
	const tokenRecord = tokenPayload as Record<string, unknown>
	const accessToken = readTokenField(tokenRecord, 'access_token')
	const refreshToken = readTokenField(tokenRecord, 'refresh_token')
	if (!accessToken) {
		return operationResult(
			{ ok: false, error: 'Token payload did not include an access_token.' },
			400,
		)
	}
	// Scope validation must precede token persistence: a rejected scope set
	// must not leave orphan token rows behind.
	if (platformApp) {
		try {
			assertScopesAllowedForPlatformApp(platformApp, scopes)
		} catch (error) {
			return operationResult(
				{
					ok: false,
					error:
						error instanceof Error
							? error.message
							: 'Requested scopes are not allowed.',
				},
				400,
			)
		}
	}
	const integrationName = platformApp
		? (
				await upsertPlatformIntegration({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					platformAppSlug: platformApp.slug,
					name: provider,
					scopes,
				})
			).name
		: await saveIntegrationConfig({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				provider,
				tokenUrl,
				apiBaseUrl,
				flow: flow === 'confidential' || flow === 'device' ? flow : 'pkce',
				usePkce,
				clientId,
				tokenExchangeStyle: resolveTokenExchangeStyle({
					tokenUrl,
					tokenExchangeStyle: input.fields.tokenExchangeStyle?.trim() ?? null,
				}),
				allowedHosts,
				...(deviceAuthorizationUrl ? { deviceAuthorizationUrl } : {}),
				authorization: authorizeUrl
					? {
							authorizeUrl,
							scopes,
							scopeSeparator,
							extraAuthorizeParams,
						}
					: null,
			})
	const ownerId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	await persistIntegrationTokens({
		env: input.env,
		userId: ownerId,
		name: integrationName,
		accessToken,
		refreshToken,
		refreshPolicy: inferIntegrationRefreshPolicy(tokenRecord),
	})
	const connected = await getJoinedIntegration({
		env: input.env,
		userId: ownerId,
		name: integrationName,
	})
	if (!platformApp) {
		const clientSecret = await resolveConnectClientSecret({
			env: input.env,
			userId: ownerId,
			provider: integrationName,
			clientSecret: input.fields.clientSecret?.trim() ?? null,
		})
		if (clientSecret && connected?.lane === 'user') {
			await persistUserOauthAppClientSecret({
				env: input.env,
				userId: ownerId,
				slug: connected.app.slug,
				value: clientSecret,
			})
		}
	}

	const nextSteps = buildConnectOauthNextSteps({
		integrationName,
		integration: {
			name: integrationName,
			tokenUrl,
			apiBaseUrl: apiBaseUrl ?? null,
			requiredHosts: allowedHosts,
			authorization: authorizeUrl
				? {
						authorizeUrl,
						scopes,
					}
				: null,
		},
	})

	await emitConnectOauthAuthSucceeded({
		env: input.env,
		userId: ownerId,
		integration: {
			name: integrationName,
			lane: platformApp ? 'platform' : 'user',
			account_label: connected?.connection.accountLabel ?? null,
			description: connected?.connection.description ?? null,
			provider: platformApp?.provider ?? null,
			platform_app_slug: platformApp?.slug ?? null,
			scopes,
			connected_at: connected?.connection.connectedAt ?? null,
			token_refreshed_at: connected?.connection.tokenRefreshedAt ?? null,
		},
	})

	return operationResult({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: Boolean(refreshToken),
		allowedHosts,
		integrationName,
		nextSteps,
	})
}

async function emitConnectOauthAuthSucceeded(input: {
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

export async function startAccountDeviceConnect(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: {
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
	}
}) {
	const started = await startIntegrationDeviceConnect({
		env: input.env,
		request: input.user.request,
		mcpUser: input.user.mcpUser,
		provider: input.fields.provider ?? '',
		platformAppSlug: input.fields.platformAppSlug,
		tokenUrl: input.fields.tokenUrl,
		apiBaseUrl: input.fields.apiBaseUrl,
		authorizeUrl: input.fields.authorizeUrl,
		deviceAuthorizationUrl: input.fields.deviceAuthorizationUrl,
		clientId: input.fields.clientId,
		clientSecret: input.fields.clientSecret,
		usePkce: input.fields.usePkce,
		scopes: input.fields.scopes,
		scopeSeparator: input.fields.scopeSeparator,
		extraAuthorizeParams: input.fields.extraAuthorizeParams,
		allowedHosts: input.fields.allowedHosts,
		tokenExchangeStyle: input.fields.tokenExchangeStyle,
	})
	if (!started.ok) {
		return operationResult(
			{ ok: false, error: started.error },
			started.status === 429 && started.retryAfterSeconds
				? {
						status: started.status,
						headers: {
							'Retry-After': String(started.retryAfterSeconds),
						},
					}
				: started.status,
		)
	}
	return operationResult({
		ok: true,
		sessionId: started.sessionId,
		userCode: started.userCode,
		verificationUri: started.verificationUri,
		verificationUriComplete: started.verificationUriComplete,
		expiresIn: started.expiresIn,
		interval: started.interval,
	})
}

export async function pollAccountDeviceConnect(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: { sessionId: string }
}) {
	const sessionId = input.fields.sessionId?.trim() ?? ''
	if (!sessionId) {
		return operationResult({ ok: false, error: 'Session id is required.' }, 400)
	}
	const polled = await pollIntegrationDeviceConnect({
		env: input.env,
		request: input.user.request,
		mcpUser: input.user.mcpUser,
		sessionId,
	})
	if (!polled.ok) {
		return operationResult(
			{
				ok: false,
				status: polled.status,
				error: polled.error,
			},
			polled.httpStatus,
		)
	}
	if (polled.status !== 'approved') {
		return operationResult({
			ok: true,
			status: polled.status,
			interval: polled.interval,
			expiresIn: polled.expiresIn,
		})
	}
	return operationResult({
		ok: true,
		status: 'approved',
		accessTokenSaved: true,
		refreshTokenSaved: polled.refreshTokenSaved,
		allowedHosts: polled.allowedHosts,
		hostApprovalLinks: polled.hostApprovalLinks,
		integrationName: polled.integrationName,
		nextSteps: polled.nextSteps,
	})
}

export async function exchangeAccountOAuthToken(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: ExchangeOAuthTokenInput
}) {
	const paramsRaw = input.fields.params?.trim() ?? null
	if (!paramsRaw) {
		return operationResult(
			{ ok: false, error: 'Token params are required.' },
			400,
		)
	}
	const platformAppSlug = input.fields.platformAppSlug?.trim() ?? null
	if (platformAppSlug) {
		return handlePlatformOAuthExchange({
			env: input.env,
			paramsRaw,
			platformAppSlug,
		})
	}

	const tokenUrl = input.fields.tokenUrl?.trim() ?? null
	const flow = input.fields.flow?.trim() ?? 'pkce'
	const allowedHosts = normalizeAllowedHosts(input.fields.allowedHosts ?? [])
	let clientSecret: string | null = null

	if (!tokenUrl) {
		return operationResult({ ok: false, error: 'Token URL is required.' }, 400)
	}
	if (flow !== 'pkce' && flow !== 'confidential') {
		return operationResult({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}
	const tokenHost = safeParseHost(tokenUrl)
	if (!tokenHost) {
		return operationResult({ ok: false, error: 'Token URL is invalid.' }, 400)
	}
	if (allowedHosts.length > 0 && !allowedHosts.includes(tokenHost)) {
		return operationResult(
			{ ok: false, error: 'Token host is not in allowed hosts.' },
			400,
		)
	}

	const tokenExchangeStyle = resolveTokenExchangeStyle({
		tokenUrl,
		tokenExchangeStyle: input.fields.tokenExchangeStyle?.trim() ?? null,
	})

	if (flow === 'confidential') {
		clientSecret = await resolveConnectClientSecret({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			provider: input.fields.provider?.trim() ?? '',
			clientSecret: input.fields.clientSecret?.trim() ?? null,
		})
		if (!clientSecret) {
			return operationResult(
				{ ok: false, error: 'Client secret is required.' },
				400,
			)
		}
	}

	return exchangeOAuthToken({
		tokenUrl,
		params: new URLSearchParams(paramsRaw),
		flow,
		clientSecret,
		style: tokenExchangeStyle,
	})
}

/**
 * Every exchange input comes from the operator-provisioned app row, never
 * from the request body, so a caller cannot point the decrypted shared client
 * secret at an arbitrary token URL. Only discoverable (enabled + published)
 * apps exchange; drafts keep refreshing existing connections server-side.
 */
async function handlePlatformOAuthExchange(input: {
	env: Env
	paramsRaw: string
	platformAppSlug: string
}) {
	const platformApp = await getAvailablePlatformApp({
		env: input.env,
		slug: input.platformAppSlug,
	})
	if (!platformApp) {
		return operationResult(
			{ ok: false, error: 'Platform integration is not available.' },
			400,
		)
	}
	let clientSecret: string | null = null
	if (platformApp.flow === 'confidential') {
		clientSecret = await getPlatformOauthAppClientSecret({
			db: input.env.APP_DB,
			env: input.env,
			slug: platformApp.slug,
		})
		if (!clientSecret) {
			return operationResult(
				{ ok: false, error: 'Platform client secret is not configured.' },
				500,
			)
		}
	}
	if (platformApp.flow === 'device') {
		return operationResult(
			{
				ok: false,
				error: 'Device flow does not use authorization code exchange.',
			},
			400,
		)
	}
	const params = new URLSearchParams(input.paramsRaw)
	params.set('client_id', platformApp.clientId)
	params.delete('client_secret')
	return exchangeOAuthToken({
		tokenUrl: platformApp.tokenUrl,
		params,
		flow: platformApp.flow === 'confidential' ? 'confidential' : 'pkce',
		clientSecret,
		style: resolveTokenExchangeStyle({
			tokenUrl: platformApp.tokenUrl,
			tokenExchangeStyle: platformApp.tokenExchangeStyle,
		}),
	})
}

async function exchangeOAuthToken(input: {
	tokenUrl: string
	params: URLSearchParams
	flow: 'pkce' | 'confidential'
	clientSecret: string | null
	style: TokenExchangeStyle
}) {
	let exchangeRequest: { headers: Record<string, string>; body: string }
	try {
		exchangeRequest = buildOAuthTokenExchangeRequest({
			params: input.params,
			flow: input.flow,
			clientSecret: input.clientSecret,
			style: input.style,
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to build token exchange request.',
			},
			400,
		)
	}

	const response = await fetch(input.tokenUrl, {
		method: 'POST',
		headers: exchangeRequest.headers,
		body: exchangeRequest.body,
	})
	const text = await response.text()
	let payload: unknown = null
	try {
		payload = JSON.parse(text)
	} catch {
		payload = null
	}
	const payloadRecord =
		payload && typeof payload === 'object' && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: null
	if (!response.ok) {
		return operationResult(
			buildOAuthTokenExchangeFailurePayload({
				providerStatus: response.status,
				payload: payloadRecord,
			}),
			oauthTokenExchangeFailureHttpStatus(),
		)
	}
	if (!payloadRecord) {
		return operationResult(
			buildOAuthTokenExchangeFailurePayload({
				providerStatus: response.status,
				payload: null,
			}),
			oauthTokenExchangeFailureHttpStatus(),
		)
	}
	if (isOAuthTokenExchangeSoftFailure(payloadRecord)) {
		return operationResult(
			buildOAuthTokenExchangeFailurePayload({
				providerStatus: response.status,
				payload: payloadRecord,
			}),
			oauthTokenExchangeFailureHttpStatus(),
		)
	}
	return operationResult(
		z
			.record(z.string(), z.json())
			.parse(normalizeOAuthTokenExchangePayload(payloadRecord)),
		response.status,
	)
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
	allowedHosts: Array<string>
	deviceAuthorizationUrl?: string | null
	authorization: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator: string | null
		extraAuthorizeParams: Record<string, string>
	} | null
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
	})
	return integration.name
}

async function resolveConnectClientSecret(input: {
	env: Env
	userId: OwnerId
	provider: string
	clientSecret?: string | null
}): Promise<string | null> {
	const inline = input.clientSecret?.trim()
	if (inline) return inline
	const slugs = await listConnectClientSecretSlugs(input)
	for (const slug of slugs) {
		const fromApp = await resolveUserOauthAppClientSecret({
			env: input.env,
			userId: input.userId,
			slug,
		})
		if (fromApp) return fromApp
	}
	return null
}

async function listConnectClientSecretSlugs(input: {
	env: Env
	userId: OwnerId
	provider: string
}): Promise<Array<string>> {
	const slugs: Array<string> = []
	const add = (slug: string | null | undefined) => {
		const normalized = slug?.trim()
		if (normalized && !slugs.includes(normalized)) slugs.push(normalized)
	}
	add(canonicalIntegrationName(input.provider))
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: input.provider,
	})
	if (joined?.lane === 'user') add(joined.app.slug)
	const setup = await findOauthAppForProviderSetup({
		env: input.env,
		userId: input.userId,
		name: input.provider,
	})
	add(setup?.slug)
	return slugs
}

function readTokenField(
	payload: Record<string, unknown>,
	field: string,
): string | null {
	const value = payload[field]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function handleApprovalAction(input: {
	request: Request
	refresh: SecretRefresh
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	action: SecretApprovalAction
}) {
	try {
		const fields = input.refresh.approval
		const classifiedHosts = classifyBulkApprovalHosts(
			fields.hosts.flatMap((value) => value.split(',')),
		)
		const scope = fields.scope
		const storageContext: StorageContext | null =
			scope === 'package' && fields.storagePackageId?.trim()
				? {
						packageId: fields.storagePackageId.trim(),
						sessionId: null,
						appId: null,
					}
				: scope === 'session' && fields.sessionId?.trim()
					? { sessionId: fields.sessionId.trim(), packageId: null, appId: null }
					: null
		const approval = resolveApprovalRequest({
			secretId: input.refresh.selectedSecretId,
			requestedHosts: classifiedHosts.valid,
			rejectedHosts: classifiedHosts.rejected,
			requestedPackageId: fields.packageId?.trim() || null,
			requestedSecretNames: normalizeBulkPackageSecretApprovalNames(
				fields.names.flatMap((value) => value.split(',')),
			),
			requestedHostScope: scope,
			requestedHostStorageContext: storageContext,
		})

		if (approval.kind === 'package_bulk') {
			if (input.action === 'approve') {
				const savedPackages = await listSavedPackagesByUserId(
					input.env.APP_DB,
					{
						userId: ownerIdFromCaller({
							request: input.user.request,
							user: input.user.mcpUser,
						}),
					},
				)
				if (!savedPackages.some((entry) => entry.id === approval.packageId)) {
					return operationResult(
						{ ok: false, error: 'Package not found for approval.' },
						404,
					)
				}
				const current = await listSecrets({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					scope: 'user',
				})
				const byName = new Map(
					current
						.filter((item) => item.scope === 'user')
						.map((item) => [item.name, item]),
				)
				const missingNames: Array<string> = []
				for (const name of approval.names) {
					const secret = byName.get(name)
					if (!secret) {
						missingNames.push(name)
						continue
					}
					if (secret.allowedPackages.includes(approval.packageId)) continue
					await setSecretAllowedPackages({
						env: input.env,
						userId: ownerIdFromCaller({
							request: input.user.request,
							user: input.user.mcpUser,
						}),
						name,
						scope: 'user',
						allowedPackages: Array.from(
							new Set([...secret.allowedPackages, approval.packageId]),
						),
						storageContext: null,
					})
				}
				if (missingNames.length === approval.names.length) {
					return operationResult(
						{ ok: false, error: 'None of the listed secrets were found.' },
						404,
					)
				}
			}
			return operationResult({
				ok: true,
				action: input.action,
				approvalKind: approval.kind,
			})
		}

		if (approval.kind === 'package') {
			if (input.action === 'approve') {
				const savedPackages = await listSavedPackagesByUserId(
					input.env.APP_DB,
					{
						userId: ownerIdFromCaller({
							request: input.user.request,
							user: input.user.mcpUser,
						}),
					},
				)
				if (!savedPackages.some((entry) => entry.id === approval.packageId)) {
					return operationResult(
						{ ok: false, error: 'Package not found for approval.' },
						404,
					)
				}
				const current = await listSecrets({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					scope: approval.scope,
					storageContext: approval.storageContext,
				})
				const secret = current.find(
					(item) =>
						item.name === approval.name && item.scope === approval.scope,
				)
				if (!secret) {
					return operationResult({ ok: false, error: 'Secret not found.' }, 404)
				}
				await setSecretAllowedPackages({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					name: approval.name,
					scope: approval.scope,
					allowedPackages: Array.from(
						new Set([...secret.allowedPackages, approval.packageId]),
					),
					storageContext: approval.storageContext,
				})
			}
			return operationResult({
				ok: true,
				action: input.action,
				approvalKind: approval.kind,
			})
		}

		if (approval.kind === 'host') {
			if (input.action === 'approve') {
				const hostsToGrant = filterValidApprovalHosts([approval.requestedHost])
				if (hostsToGrant.length === 0) {
					return operationResult(
						{
							ok: false,
							error:
								'None of the requested hosts are valid. The approval link may have been truncated — copy it again.',
						},
						400,
					)
				}
				const current = await listSecrets({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					scope: approval.scope,
					storageContext: approval.storageContext,
				})
				const secret = current.find(
					(item) =>
						item.name === approval.name && item.scope === approval.scope,
				)
				if (!secret) {
					return operationResult({ ok: false, error: 'Secret not found.' }, 404)
				}
				await setSecretAllowedHosts({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					name: approval.name,
					scope: approval.scope,
					allowedHosts: normalizeAllowedHosts([
						...secret.allowedHosts,
						...hostsToGrant,
					]),
					storageContext: approval.storageContext,
				})
			}

			return operationResult({
				ok: true,
				action: input.action,
				approvalKind: approval.kind,
			})
		}

		if (approval.kind === 'host_bulk') {
			if (input.action === 'approve') {
				const hostsToGrant = filterValidApprovalHosts(approval.hosts)
				if (hostsToGrant.length === 0) {
					return operationResult(
						{
							ok: false,
							error:
								'None of the requested hosts are valid. The approval link may have been truncated — copy it again.',
						},
						400,
					)
				}
				const current = await listSecrets({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					scope: approval.scope,
					storageContext: approval.storageContext,
				})
				const byName = new Map(
					current
						.filter((item) => item.scope === approval.scope)
						.map((item) => [item.name, item]),
				)
				const missingNames: Array<string> = []
				for (const name of approval.names) {
					const secret = byName.get(name)
					if (!secret) {
						missingNames.push(name)
						continue
					}
					await setSecretAllowedHosts({
						env: input.env,
						userId: ownerIdFromCaller({
							request: input.user.request,
							user: input.user.mcpUser,
						}),
						name,
						scope: approval.scope,
						allowedHosts: normalizeAllowedHosts([
							...secret.allowedHosts,
							...hostsToGrant,
						]),
						storageContext: approval.storageContext,
					})
				}
				if (missingNames.length === approval.names.length) {
					return operationResult(
						{ ok: false, error: 'None of the listed secrets were found.' },
						404,
					)
				}
			}
			return operationResult({
				ok: true,
				action: input.action,
				approvalKind: approval.kind,
			})
		}

		const _exhaustive: never = approval
		throw new Error(`Unsupported approval kind: ${String(_exhaustive)}`)
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to process approval request.',
			},
			400,
		)
	}
}

export async function saveAccountSecret(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: SaveSecretInput
}) {
	const currentId = input.fields.currentId?.trim() ?? null
	const name = input.fields.name?.trim() || null
	let value = input.fields.value?.trim() || null
	const scope =
		input.fields.scope === 'user' || input.fields.scope === 'package'
			? input.fields.scope
			: null
	const description = input.fields.description?.trim() ?? ''
	const expiresAt = readOptionalExpiresAt(input.fields)
	if (expiresAt === false) {
		return operationResult(
			{
				ok: false,
				error:
					'Expiry must be a UTC ISO timestamp (for example 2026-12-01T00:00:00Z), a YYYY-MM-DD date, or empty.',
			},
			400,
		)
	}
	const allowedHosts = normalizeAllowedHosts(input.fields.allowedHosts ?? [])
	const allowedPackages = normalizeAllowedPackages(
		input.fields.allowedPackages ?? [],
	)
	const providerText = input.fields.provider?.trim() ?? null
	const provider = providerText
		? credentialProviderSchema.safeParse(providerText)
		: null
	// An empty string clears the provider; null or a missing field keeps it.
	const clearProvider = providerText === ''
	if (provider && !provider.success) {
		return operationResult(
			{ ok: false, error: provider.error.issues[0]?.message },
			400,
		)
	}
	const optIn = readOptInCredentialInput(input.fields)
	if (!optIn.ok) {
		return operationResult({ ok: false, error: optIn.error }, 400)
	}
	let requestedPlacement: CredentialFillPlacement | null | undefined
	if (input.fields.placement !== undefined) {
		if (input.fields.placement === null) {
			requestedPlacement = null
		} else {
			const parsedPlacement = credentialFillPlacementSchema.safeParse(
				input.fields.placement,
			)
			if (!parsedPlacement.success) {
				return operationResult(
					{
						ok: false,
						error:
							parsedPlacement.error.issues[0]?.message ??
							'Placement must allow at least one request part.',
					},
					400,
				)
			}
			requestedPlacement = parsedPlacement.data
		}
	}
	const touchesKind =
		optIn.kind !== undefined ||
		optIn.hosts !== undefined ||
		optIn.loginExchange !== undefined
	if (touchesKind && !value) {
		return operationResult(
			{
				ok: false,
				error:
					'Enter the value again to set its kind or hosts: whoever supplies the value decides where it may go.',
			},
			400,
		)
	}
	if (touchesKind && optIn.kind !== 'secret' && allowedHosts.length > 0) {
		return operationResult(
			{
				ok: false,
				error:
					'URL, login, and signing credentials take hosts, not approved hosts.',
			},
			400,
		)
	}

	if (!name) {
		return operationResult(
			{ ok: false, error: 'Secret name is required.' },
			400,
		)
	}
	if (!scope) {
		return operationResult(
			{ ok: false, error: 'Secret scope is required.' },
			400,
		)
	}
	if (scope === 'package' && allowedPackages.length > 0) {
		return operationResult(
			{
				ok: false,
				error: 'Package secrets are accessible only to their owning package.',
			},
			400,
		)
	}

	if (!value && currentId) {
		const parsed = parseAccountSecretId(currentId)
		if (parsed) {
			const existing = await resolveSecret({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				name: parsed.name,
				scope: parsed.scope,
				includeExpired: true,
				storageContext: getSecretContextForAccountSecret(parsed),
			})
			if (existing.found && existing.value != null) {
				value = existing.value
			}
		}
	}

	if (!value) {
		return operationResult(
			{ ok: false, error: 'Secret value is required.' },
			400,
		)
	}

	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
	})
	const packageOptions = toPackageOptions(savedPackages)
	const packageId = readPackageIdForScope({
		packageId: input.fields.packageId,
		scope,
		packageOptions,
	})
	if (scope === 'package' && !packageId) {
		return operationResult(
			{ ok: false, error: 'Choose a package for package secrets.' },
			400,
		)
	}

	const secrets = await listAccountSecrets({
		env: input.env,
		user: input.user,
		packageOptions,
	})
	const secretById = new Map(secrets.map((secret) => [secret.id, secret]))
	const currentSecret = currentId ? (secretById.get(currentId) ?? null) : null
	if (currentId && !currentSecret) {
		return operationResult({ ok: false, error: 'Secret not found.' }, 404)
	}

	const nextId = buildAccountSecretId({
		name,
		scope,
		packageId,
	})
	// Uniqueness matches lookup: exact (case-sensitive) name + scope. A
	// case-only rename of the current secret is therefore not a collision.
	if (currentId !== nextId && secretById.has(nextId)) {
		return operationResult(
			{
				ok: false,
				error: 'A secret with that name and scope already exists.',
			},
			409,
		)
	}

	const samePlacement =
		currentSecret != null &&
		currentSecret.scope === scope &&
		(currentSecret.packageId ?? null) === (packageId ?? null)
	const nameChanged = currentSecret != null && currentSecret.name !== name
	// Same-scope renames (including Henry → henry) update the row in place so
	// the credential id and opt-in kind stay put. Scope/package moves still use
	// create-under-new + delete-old below. Validate before renaming so a failed
	// save cannot leave the editor pointing at a name that no longer exists.
	const willRenameInPlace = nameChanged && samePlacement

	const orgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	let credential: SaveSecretCredential | null = null
	// Without an explicit kind an existing opt-in credential keeps its hosts;
	// Key host approvals below must not overwrite them.
	let keepsOptInHosts = false
	try {
		if (touchesKind) {
			const plan = await planOptInCredentialFieldsForOrg({
				db: input.env.APP_DB,
				orgId,
				input: {
					name,
					scope,
					value,
					kind: optIn.kind,
					hosts: optIn.hosts,
					login_exchange: optIn.loginExchange,
					...(requestedPlacement !== undefined
						? { placement: requestedPlacement }
						: {}),
					...(provider?.success
						? { provider: provider.data }
						: clearProvider
							? { provider: null }
							: {}),
				},
				authorityPackageId: null,
			})
			if (plan.mode === 'with-value') {
				credential = withCredentialAudit(
					plan,
					orgAuditWriterFromRequest(input.env, input.user.request),
				)
			}
		} else if (scope === 'user' || currentSecret?.scope === 'user') {
			const placement = await readStoredCredentialPlacement({
				db: input.env.APP_DB,
				orgId,
				// Still under the prior name until rename commits below.
				name: currentSecret?.scope === 'user' ? currentSecret.name : name,
			})
			keepsOptInHosts = placement != null && placement.kind !== 'secret'
			if (placement && keepsOptInHosts) {
				if (currentSecret && currentId !== nextId && !willRenameInPlace) {
					return operationResult(
						{
							ok: false,
							error:
								'Renaming or moving a URL, login, or signing credential here would drop its kind. Create it again under the new name instead.',
						},
						400,
					)
				}
				if (
					allowedHosts.length > 0 &&
					!sameHostList(allowedHosts, placement.allowedHosts)
				) {
					return operationResult(
						{
							ok: false,
							error:
								'URL, login, and signing credentials take hosts, not approved hosts. Edit its hosts from the credential creation page with its value.',
						},
						400,
					)
				}
			}
		}
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error ? error.message : 'Unable to save secret.',
			},
			400,
		)
	}

	let renamedInPlace = false
	if (willRenameInPlace && currentSecret) {
		try {
			const renamed = await renameSecret({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				scope: currentSecret.scope,
				fromName: currentSecret.name,
				toName: name,
				storageContext: getSecretContextForAccountSecret(currentSecret),
			})
			if (renamed.name !== name) {
				return operationResult(
					{
						ok: false,
						error: 'Secret rename did not persist the new name.',
					},
					500,
				)
			}
			renamedInPlace = true
		} catch (error) {
			return operationResult(
				{
					ok: false,
					error:
						error instanceof Error ? error.message : 'Unable to rename secret.',
				},
				error instanceof Error && error.message.includes('already exists')
					? 409
					: 400,
			)
		}
	}

	const setsKeyHosts =
		credential == null ? !keepsOptInHosts : credential.kind === 'secret'

	// Scope/package moves insert under a new bucket. Preserve the source
	// placement (including null = anywhere) so headers-only default does not
	// narrow an existing credential. An explicit form placement wins.
	let placementOnInsert: CredentialFillPlacement | null | undefined
	if (requestedPlacement !== undefined && credential == null) {
		placementOnInsert = requestedPlacement
	} else if (currentSecret && !samePlacement && credential == null) {
		const source = await findSecret({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			name: currentSecret.name,
			scope: currentSecret.scope,
			storageContext: getSecretContextForAccountSecret(currentSecret),
			// Moves must preserve placement even when the source is expired.
			includeExpired: true,
		})
		if (source.found) placementOnInsert = source.placement
	}

	let saved: Awaited<ReturnType<typeof saveSecret>>
	try {
		saved = await saveSecret({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			userEmail: input.user.mcpUser.email,
			name,
			value,
			scope,
			description,
			expiresAt,
			storageContext: getSecretContextForAccountSecret({
				scope,
				packageId,
			}),
			...(credential ? { credential } : {}),
			...(placementOnInsert !== undefined ? { placementOnInsert } : {}),
		})
		if (
			requestedPlacement !== undefined &&
			credential == null &&
			currentSecret &&
			samePlacement &&
			serializeCredentialFillPlacement(currentSecret.placement) !==
				serializeCredentialFillPlacement(requestedPlacement)
		) {
			const found = await findSecret({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				name,
				scope,
				storageContext: getSecretContextForAccountSecret({
					scope,
					packageId,
				}),
				includeExpired: true,
			})
			if (found.found && found.credentialId) {
				await updateCredentialFields({
					db: input.env.APP_DB,
					orgId,
					credentialId: found.credentialId,
					update: { placement: requestedPlacement },
					audit: orgAuditWriterFromRequest(input.env, input.user.request),
				})
			}
		}
		if (setsKeyHosts) {
			await setSecretAllowedHosts({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				name,
				scope,
				allowedHosts,
				storageContext: getSecretContextForAccountSecret({
					scope,
					packageId,
				}),
			})
		}
		await setSecretAllowedPackages({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			name,
			scope,
			allowedPackages,
			storageContext: getSecretContextForAccountSecret({
				scope,
				packageId,
			}),
		})
	} catch (error) {
		const saveError =
			error instanceof Error ? error.message : 'Unable to save secret.'
		if (renamedInPlace && currentSecret) {
			try {
				await renameSecret({
					env: input.env,
					userId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					scope: currentSecret.scope,
					fromName: name,
					toName: currentSecret.name,
					storageContext: getSecretContextForAccountSecret(currentSecret),
				})
				renamedInPlace = false
			} catch {
				// Rename stuck at the new name, surface it so the editor can
				// retarget currentId instead of 404ing on the prior casing.
				return operationResult(
					{
						ok: false,
						error: saveError,
						selectedSecret: { id: nextId, name },
					},
					400,
				)
			}
		}
		return operationResult({ ok: false, error: saveError }, 400)
	}

	// Post-commit provider link must not claim the save failed — a create retry
	// with currentId null would 409 on the same name (#3725 / #3698).
	let providerLinkError: string | null = null
	let renameCleanupError: string | null = null
	if ((provider?.success || clearProvider) && scope === 'user' && !credential) {
		try {
			const stored = await findSecret({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				name,
				scope,
				includeExpired: true,
				storageContext: getSecretContextForAccountSecret({
					scope,
					packageId,
				}),
			})
			if (stored.credentialId) {
				await updateCredentialFields({
					db: input.env.APP_DB,
					orgId: ownerIdFromCaller({
						request: input.user.request,
						user: input.user.mcpUser,
					}),
					credentialId: stored.credentialId,
					update: { provider: provider?.success ? provider.data : null },
					audit: orgAuditWriterFromRequest(input.env, input.user.request),
				})
			}
		} catch (error) {
			providerLinkError =
				error instanceof Error
					? error.message
					: 'Secret saved, but linking the credential provider failed.'
		}
	}

	if (currentSecret && currentSecret.id !== nextId && !renamedInPlace) {
		try {
			await deleteSecret({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				name: currentSecret.name,
				scope: currentSecret.scope,
				storageContext: getSecretContextForAccountSecret(currentSecret),
			})
		} catch (error) {
			// New secret is already saved; leaving the prior name is recoverable.
			renameCleanupError =
				error instanceof Error
					? error.message
					: 'Secret saved under the new name, but removing the previous secret failed.'
		}
	}

	const selectedSecret = {
		id: nextId,
		name,
		scope,
		description,
		packageId: packageId ?? null,
		packageTitle:
			packageId == null
				? null
				: (packageOptions.find((option) => option.id === packageId)?.title ??
					null),
		allowedHosts,
		allowedPackages,
		createdAt: saved.createdAt,
		updatedAt: saved.updatedAt,
		expiresAt: saved.expiresAt,
		ttlMs: saved.ttlMs,
		// saveSecret returns the pre-update row for existing secrets; when this
		// handler wrote placement (insert or updateCredentialFields), prefer it.
		placement:
			requestedPlacement !== undefined && credential == null
				? requestedPlacement
				: saved.placement,
		value,
	}
	return operationResult({
		ok: true,
		selectedSecret,
		...(providerLinkError ? { providerLinkError } : {}),
		...(renameCleanupError ? { renameCleanupError } : {}),
	})
}

export async function deleteAccountSecret(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	fields: { currentId: string }
}) {
	const currentId = input.fields.currentId?.trim() || null
	if (!currentId) {
		return operationResult({ ok: false, error: 'Secret id is required.' }, 400)
	}

	const secret = parseAccountSecretId(currentId)
	if (!secret || secret.scope === 'session') {
		return operationResult({ ok: false, error: 'Invalid secret id.' }, 400)
	}

	const deleted = await deleteSecret({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		name: secret.name,
		scope: secret.scope,
		storageContext: getSecretContextForAccountSecret(secret),
	})
	if (!deleted) {
		return operationResult({ ok: false, error: 'Secret not found.' }, 404)
	}

	return operationResult({ ok: true, deleted: true, secretId: currentId })
}

function readOptionalExpiresAt(body: object) {
	if (!Object.hasOwn(body, 'expiresAt')) return undefined
	const value = (body as Record<string, unknown>).expiresAt
	if (value == null) return null
	if (typeof value !== 'string') return false
	try {
		return normalizeSecretExpiresAt(value)
	} catch {
		return false
	}
}

function sameHostList(left: Array<string>, right: Array<string>) {
	const rightSet = new Set(right.map((host) => host.toLowerCase()))
	return (
		left.length === rightSet.size &&
		left.every((host) => rightSet.has(host.toLowerCase()))
	)
}

const storedCredentialKindSchema = z.enum([
	'secret',
	...optInStoredCredentialKinds,
])

/** The opt-in credential fields (ADR 0068); each is undefined when absent. */
function readOptInCredentialInput(body: object):
	| {
			ok: true
			kind: z.infer<typeof storedCredentialKindSchema> | undefined
			hosts: Array<string> | undefined
			loginExchange: LoginExchange | undefined
	  }
	| { ok: false; error: string } {
	const record = body as Record<string, unknown>
	const fields = z
		.object({
			kind: storedCredentialKindSchema.optional(),
			hosts: credentialHostsSchema.optional(),
			loginExchange: loginExchangeSchema.optional(),
		})
		.safeParse({
			kind: record.kind ?? undefined,
			hosts: record.hosts ?? undefined,
			loginExchange: record.loginExchange ?? undefined,
		})
	if (!fields.success) {
		const issue = fields.error.issues[0]
		const field = issue?.path[0] === 'loginExchange' ? 'Login exchange' : null
		return {
			ok: false,
			error: field
				? `${field}: ${issue?.message ?? 'invalid.'}`
				: (issue?.message ?? 'Invalid credential fields.'),
		}
	}
	return {
		ok: true,
		kind: fields.data.kind,
		hosts: fields.data.hosts,
		loginExchange: fields.data.loginExchange,
	}
}

function readPackageIdForScope(input: {
	packageId?: string | null
	scope: AccountEditableSecretScope
	packageOptions: Array<SavedPackageOption>
}) {
	if (input.scope !== 'package') return null
	const packageId = input.packageId?.trim() || null
	if (!packageId) return null
	return input.packageOptions.some(
		(packageOption) => packageOption.id === packageId,
	)
		? packageId
		: null
}

export function approveAccountSecretAccess(
	input: Omit<Parameters<typeof handleApprovalAction>[0], 'action'>,
) {
	return handleApprovalAction({ ...input, action: 'approve' })
}
export function rejectAccountSecretAccess(
	input: Omit<Parameters<typeof handleApprovalAction>[0], 'action'>,
) {
	return handleApprovalAction({ ...input, action: 'reject' })
}
