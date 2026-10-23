import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	type OAuthHelpers,
	type TokenSummary,
} from '@cloudflare/workers-oauth-provider'
import {
	buildProtectedResourceMetadata,
	handleMcpRequest,
	mcpInvalidTokenDescription,
	mcpParsedBodyNeedsAccountWriteLease,
	mcpProtectedResourceMetadataUrl,
	mcpResourcePath,
	protectedResourceMetadataPath,
} from './mcp-auth.ts'
import { oauthScopes } from './oauth-handlers.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	consoleError,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { createWaitUntilDrain } from '#worker/test-support/user-meter.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const origin = 'https://example.com'
const epoch = new Date(0).toISOString()
const verified = { emailVerifiedAt: epoch }

function expectAuthenticateHeader(
	response: Response,
	challengeOrigin: string,
	kind: 'missing_credential' | 'invalid_token' = 'invalid_token',
) {
	const header = response.headers.get('WWW-Authenticate') ?? ''
	switch (kind) {
		case 'missing_credential':
			expect(header).not.toContain('error=')
			expect(header).not.toContain('error_description=')
			break
		case 'invalid_token':
			expect(header).toContain('error="invalid_token"')
			expect(header).toContain(
				`error_description="${mcpInvalidTokenDescription}"`,
			)
			break
		default: {
			const exhaustive: never = kind
			throw new Error(`unexpected challenge kind: ${exhaustive}`)
		}
	}
	expect(header).toContain(
		`resource_metadata="${mcpProtectedResourceMetadataUrl(challengeOrigin)}"`,
	)
	if (oauthScopes.length > 0) {
		expect(header).toContain(`scope="${oauthScopes.join(' ')}"`)
	}
}

function createHelpers(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
	return {
		async parseAuthRequest() {
			throw new Error('Not implemented')
		},
		lookupClient: async () => null,
		completeAuthorization: async () => ({ redirectTo: 'https://example.com' }),
		describeConsent: async () => ({
			clientId: 'client',
			clientName: 'client',
			redirectUri: 'https://example.com/callback',
			redirectHost: 'example.com',
			redirectIsLoopback: false,
			scope: [],
		}),
		isConsentRemembered: async () => false,
		beginConsent: async () => ({
			handle: 'handle',
			headers: new Headers(),
		}),
		approveConsent: async () => ({
			request: {} as never,
			headers: new Headers(),
		}),
		denyConsent: async () => ({
			request: {} as never,
			redirectTo: 'https://example.com/denied',
			headers: new Headers({ Location: 'https://example.com/denied' }),
		}),
		beginUpstream: async () => ({
			state: 'state',
			headers: new Headers(),
		}),
		finishUpstream: async <Data = unknown>() =>
			({
				request: {} as never,
				data: undefined as Data,
				headers: new Headers(),
			}) as never,
		async createClient() {
			throw new Error('Not implemented')
		},
		listClients: async () => ({ items: [] }),
		updateClient: async () => null,
		deleteClient: async () => undefined,
		listUserGrants: async () => ({ items: [] }),
		revokeGrant: async () => undefined,
		unwrapToken: async () => null,
		async exchangeToken() {
			throw new Error('Not implemented')
		},
		purgeExpiredData: async () => ({
			grantsChecked: 0,
			grantsPurged: 0,
			tokensChecked: 0,
			tokensPurged: 0,
			done: true,
		}),
		...overrides,
	}
}

type MockAccountRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
	email_verified_at: string | null
	deleting_at?: string | null
	suspended_at?: string | null
	password_changed_at?: string | null
}

type MockDbOptions = {
	// Default profile row fields; the row is absent when emailVerifiedAt is
	// undefined.
	emailVerifiedAt?: string | null
	suspendedAt?: string | null
	passwordChangedAt?: string | null
	// Expected bind values for the default verified fixture identity.
	expectedEmail?: string
	expectedStableUserId?: string
	// Optional authoritative users row for stable-id profile/RBAC resolution.
	accountByStableId?: MockAccountRow | null
	// Rows returned for remote connector settings queries.
	connectorRows?: Array<Record<string, unknown>>
	// Optional sink for audit rows written while rejecting a request.
	auditInserts?: Array<Array<unknown>>
	// Optional sink for consolidated users SELECTs.
	userSelects?: Array<string>
	// Optional deleting_at for the write-lease D1 gate only (profile lookup
	// still uses accountByStableId.deleting_at). Lets tests reach 409 without
	// the auth context loader treating the account as unidentified.
	writableCheckDeletingAt?: string | null
}

function createMockDb(options: MockDbOptions = {}) {
	const defaultEmail = options.expectedEmail ?? 'user@example.com'
	const defaultStableUserId = options.expectedStableUserId ?? 'user'
	const expectedLeaseUserId =
		options.accountByStableId?.stable_user_id ?? defaultStableUserId
	const statementFor = (query: string) => {
		const normalized = query.replace(/\s+/g, ' ').toLowerCase()
		let boundParams: Array<unknown> = []
		const statement = {
			query,
			bind(...params: Array<unknown>) {
				boundParams = params
				return statement
			},
			async all() {
				if (normalized.includes('from user_roles')) {
					return { results: [], meta: { changes: 0 } }
				}
				return {
					results: options.connectorRows ?? [],
					meta: { changes: 0 },
				}
			},
			async run() {
				// Denials that resolve to a principal are recorded in the audit
				// log on the way out.
				if (normalized.startsWith('insert into audit_events')) {
					options.auditInserts?.push(boundParams)
					return { meta: { changes: 1 } }
				}
				if (normalized.startsWith('update users')) {
					if (
						!normalized.includes('where stable_user_id = ?') ||
						!boundParams.includes(expectedLeaseUserId)
					) {
						throw new Error('Unscoped account write lease update.')
					}
					return { meta: { changes: 1 } }
				}
				throw new Error(`Unsupported run query: ${query}`)
			},
			async first() {
				const boundStableUserId =
					typeof boundParams[0] === 'string' ? boundParams[0] : null
				const isProfileLookup =
					normalized.includes('from users') &&
					normalized.includes('where stable_user_id') &&
					normalized.includes('select id')
				if (isProfileLookup) {
					options.userSelects?.push(normalized)
					if (!boundStableUserId) return null
					if (options.accountByStableId !== undefined) {
						if (
							options.accountByStableId === null ||
							options.accountByStableId.stable_user_id !== boundStableUserId
						) {
							return null
						}
						return options.accountByStableId
					}
					if (boundStableUserId !== defaultStableUserId) return null
					const verifiedAt = options.emailVerifiedAt
					if (verifiedAt === undefined) return null
					return {
						id: 1,
						email: defaultEmail,
						username: 'user',
						display_name: null,
						stable_user_id: defaultStableUserId,
						email_verified_at: verifiedAt,
						deleting_at: null,
						suspended_at: options.suspendedAt ?? null,
						password_changed_at: options.passwordChangedAt ?? null,
					} satisfies MockAccountRow
				}
				if (
					normalized.includes('select deleting_at from users') ||
					normalized.includes(
						'select deleting_at, stable_user_id, personal_org_id',
					)
				) {
					if (!boundStableUserId) return null
					if (options.writableCheckDeletingAt !== undefined) {
						return { deleting_at: options.writableCheckDeletingAt }
					}
					if (options.accountByStableId !== undefined) {
						if (
							options.accountByStableId === null ||
							options.accountByStableId.stable_user_id !== boundStableUserId
						) {
							return null
						}
						return {
							deleting_at: options.accountByStableId.deleting_at ?? null,
						}
					}
					if (boundStableUserId !== defaultStableUserId) return null
					return { deleting_at: null }
				}
				if (
					normalized.includes('select suspended_at from users') ||
					normalized.includes('email_verified_at')
				) {
					// Identity, verification, and suspension come from the one
					// consolidated profile lookup above; any per-field users
					// lookup is a regression.
					throw new Error(`Unexpected per-field users lookup: ${query}`)
				}
				if (isOrgBindingMembershipQuery(normalized)) {
					const personId =
						typeof boundParams[0] === 'string' ? boundParams[0] : null
					if (!personId) return null
					return mockPersonalOrgBindingRow(personId)
				}
				if (
					normalized.includes('from org_memberships') ||
					normalized.includes('join org_memberships')
				) {
					return null
				}
				const result = await statement.all()
				return result.results[0] ?? null
			},
		}
		return statement
	}
	return {
		prepare: (query: string) => statementFor(query),
		async batch(
			statements: Array<{
				query: string
				run: () => Promise<unknown>
				first: () => Promise<unknown>
			}>,
		) {
			const results = []
			for (const statement of statements) {
				if (statement.query.trimStart().toLowerCase().startsWith('select')) {
					const row = await statement.first()
					results.push({ results: row == null ? [] : [row], meta: {} })
					continue
				}
				results.push(await statement.run())
			}
			return results
		},
	} as unknown as D1Database
}

function createEnv(
	helpers: OAuthHelpers,
	overrides: Partial<Env> = {},
	dbOptions: MockDbOptions = {},
) {
	const db = createMockDb(dbOptions)
	return {
		APP_DB: db,
		AUDIT_DB: db,
		OAUTH_PROVIDER: helpers,
		USER_METER: env.USER_METER,
		...overrides,
	} as unknown as Env
}

function tokenEnv(
	token: TokenSummary | null,
	dbOptions: MockDbOptions = {},
	overrides: Partial<Env> = {},
) {
	return createEnv(
		createHelpers({ unwrapToken: async () => token }),
		overrides,
		dbOptions,
	)
}

type FetchMcp = Parameters<typeof handleMcpRequest>[0]['fetchMcp']

async function callMcp(
	request: Request,
	mcpEnv: Env,
	fetchMcp: FetchMcp = () => new Response('ok'),
) {
	const drain = createWaitUntilDrain()
	const ctx = {
		props: {},
		waitUntil: drain.waitUntil,
		passThroughOnException: () => undefined,
	}
	const response = await handleMcpRequest({
		request,
		env: mcpEnv,
		ctx: ctx as unknown as ExecutionContext,
		fetchMcp,
	})
	await drain.drain()
	return response
}

function mcpToken({
	userId = 'user',
	email = 'user@example.com',
	props = { userId, email },
	clientId = 'client',
	createdAt = 0,
	expiresAt = 999_999,
}: {
	userId?: string
	email?: string
	props?: Record<string, unknown>
	clientId?: string
	createdAt?: number
	expiresAt?: number
} = {}): TokenSummary {
	return {
		id: 'token',
		grantId: 'grant',
		userId,
		createdAt,
		expiresAt,
		audience: `${origin}${mcpResourcePath}`,
		scope: oauthScopes,
		grant: { clientId, scope: oauthScopes, props },
	}
}

function accountRow(
	id: number,
	email: string,
	stableUserId: string,
): MockAccountRow {
	return {
		id,
		email,
		username: email.split('@')[0] ?? null,
		display_name: null,
		stable_user_id: stableUserId,
		email_verified_at: epoch,
		deleting_at: null,
	}
}

function bearerRequest(requestOrigin = origin) {
	return new Request(`${requestOrigin}${mcpResourcePath}`, {
		headers: { Authorization: 'Bearer token' },
	})
}

function jsonRpcRequest(body: unknown, headers: Record<string, string> = {}) {
	return new Request(`${origin}${mcpResourcePath}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer token',
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify(body),
	})
}

function countingFetchMcp(body = 'ok') {
	const counter = {
		calls: 0,
		fetchMcp: () => {
			counter.calls += 1
			return new Response(body)
		},
	}
	return counter
}

test('mcp endpoint serves browser guidance without changing protocol auth challenges', async () => {
	const unauthenticatedEnv = createEnv(createHelpers())
	const mcpUrl = `${origin}${mcpResourcePath}`
	const fetchMcp = () => {
		throw new Error(
			'Unauthenticated requests must not reach the MCP transport.',
		)
	}

	const browserResponse = await callMcp(
		new Request(mcpUrl, {
			headers: {
				Accept:
					'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
		}),
		unauthenticatedEnv,
		fetchMcp,
	)
	expect(browserResponse.status).toBe(200)
	expect(browserResponse.headers.get('Content-Type')).toBe(
		'text/html; charset=utf-8',
	)
	expect(browserResponse.headers.get('WWW-Authenticate')).toBeNull()

	const challenges = [
		[
			new Request(mcpUrl, { headers: { Accept: 'text/event-stream' } }),
			'missing_credential',
		],
		[
			new Request(mcpUrl, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
			}),
			'missing_credential',
		],
		[
			new Request(mcpUrl, { headers: { Authorization: 'Bearer ' } }),
			'missing_credential',
		],
		[
			new Request(mcpUrl, {
				headers: { Accept: 'text/html', Authorization: 'Bearer invalid-token' },
			}),
			'invalid_token',
		],
		[
			new Request(mcpUrl, {
				headers: { Authorization: 'bearer invalid-token' },
			}),
			'invalid_token',
		],
	] as const
	for (const [request, kind] of challenges) {
		const response = await callMcp(request, unauthenticatedEnv, fetchMcp)
		expect(response.status).toBe(401)
		expect(response.headers.get('Content-Type')).toMatch(/application\/json/)
		expect(await response.json()).toEqual(
			kind === 'invalid_token'
				? {
						error: 'invalid_token',
						error_description: mcpInvalidTokenDescription,
					}
				: { error_description: mcpInvalidTokenDescription },
		)
		expectAuthenticateHeader(response, origin, kind)
	}
})

test('protected resource metadata and auth challenge use the request origin over APP_BASE_URL', async () => {
	// MCP clients require resource metadata to match the URL they connected to.
	const requestOrigin = 'https://kody-production.kentcdodds.workers.dev'
	const envOverrides = { APP_BASE_URL: 'https://heykody.dev' }
	expect(buildProtectedResourceMetadata(requestOrigin)).toEqual({
		resource: `${requestOrigin}/mcp`,
		authorization_servers: [requestOrigin],
		scopes_supported: oauthScopes,
		bearer_methods_supported: ['header'],
	})
	expect(mcpProtectedResourceMetadataUrl(requestOrigin)).toBe(
		`${requestOrigin}${protectedResourceMetadataPath}/mcp`,
	)

	const unauthorized = await callMcp(
		new Request(`${requestOrigin}${mcpResourcePath}`),
		createEnv(createHelpers(), envOverrides),
	)
	expect(unauthorized.status).toBe(401)
	expectAuthenticateHeader(unauthorized, requestOrigin, 'missing_credential')
})

test('mcp request enforces token audience and forwards caller props', async () => {
	const request = bearerRequest()
	const tokenWithoutAudience = mcpToken()
	delete tokenWithoutAudience.audience
	for (const token of [null, tokenWithoutAudience]) {
		const response = await callMcp(request, tokenEnv(token))
		expect(response.status).toBe(401)
		expectAuthenticateHeader(response, origin)
	}

	const userSelects: Array<string> = []
	let receivedProps: unknown = null
	const captureProps: FetchMcp = (_request, _env, ctx) => {
		receivedProps = ctx.props
		return new Response('ok')
	}
	const validResponse = await callMcp(
		request,
		tokenEnv(mcpToken(), { ...verified, userSelects }),
		captureProps,
	)
	expect(validResponse.status).toBe(200)
	expect(receivedProps).toMatchObject({
		baseUrl: 'https://example.com',
		executionOrigin: 'interactive',
		storageContext: null,
		user: { userId: ownerIdFromStored('user') },
	})
	// Legacy agent props persist in Durable Object storage; derived ids do not.
	expect(receivedProps).not.toHaveProperty('actor')
	expect(receivedProps).not.toHaveProperty('owner')
	expect(userSelects).toHaveLength(1)
	expect(userSelects[0]).toContain('email_verified_at')
	expect(userSelects[0]).toContain('suspended_at')
	expect(userSelects[0]).toContain('password_changed_at')

	const withConnectorResponse = await callMcp(
		request,
		tokenEnv(mcpToken(), {
			...verified,
			connectorRows: [
				{
					id: 'connector-1',
					user_id: ownerIdFromStored('user'),
					instance_id: 'home',
					enabled: 1,
					attached: 1,
					encrypted_shared_secret: 'encrypted',
					created_at: epoch,
					updated_at: epoch,
				},
			],
		}),
		captureProps,
	)
	expect(withConnectorResponse.status).toBe(200)

	// The failing D1 lookup logs the roles-load failure before the request
	// rethrows the underlying error.
	consoleError.mockImplementation(() => {})
	const appDbUnavailable = {
		prepare: () => {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database
	await expect(
		callMcp(
			request,
			tokenEnv(mcpToken(), {}, { APP_DB: appDbUnavailable }),
			captureProps,
		),
	).rejects.toThrow('D1 unavailable')
	expect(consoleError).toHaveBeenCalledWith(
		'Failed to load MCP auth user context:',
		expect.any(Error),
	)
}, 15_000)

test('mcp request returns library insufficient_scope step-up when required scopes are missing', async () => {
	const narrow = mcpToken()
	narrow.scope = ['openid']
	narrow.grant = { ...narrow.grant, scope: ['openid'] }
	const stepUp = await callMcp(bearerRequest(), tokenEnv(narrow, verified))
	expect(stepUp.status).toBe(403)
	expect(await stepUp.json()).toEqual({ error: 'insufficient_scope' })
	const challenge = stepUp.headers.get('WWW-Authenticate') ?? ''
	expect(challenge).toContain('error="insufficient_scope"')
	expect(challenge).toContain(`scope="${oauthScopes.join(' ')}"`)
	expect(challenge).toContain(
		`resource_metadata="${mcpProtectedResourceMetadataUrl(origin)}"`,
	)
})

test('mcp requests route by protocol era and record lane metrics', async () => {
	// The token env's fake D1 rejects the feature-flag exposure rollup that
	// `tools/list` records while resolving caller flags.
	silenceExpectedConsoleWarns(['flag-exposure-rollup-failed'])
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const mcpEnv = tokenEnv(mcpToken(), verified, {
		MCP_PROTOCOL_EVENTS: {
			writeDataPoint: (point: AnalyticsEngineDataPoint) => {
				dataPoints.push(point)
			},
		} as AnalyticsEngineDataset,
	})
	const legacyLane = countingFetchMcp('legacy-lane')

	// 2025-era handshake stays on the sessionful Durable Object lane.
	const legacyResponse = await callMcp(
		jsonRpcRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'legacy-client', version: '1.0.0' },
			},
		}),
		mcpEnv,
		legacyLane.fetchMcp,
	)
	expect(await legacyResponse.text()).toBe('legacy-lane')
	expect(legacyLane.calls).toBe(1)

	// 2026-07-28 envelope requests are served by the stateless lane and
	// never reach the Durable Object.
	const modernResponse = await callMcp(
		jsonRpcRequest(
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
						'io.modelcontextprotocol/clientInfo': {
							name: 'modern-client',
							version: '2.0.0',
						},
					},
				},
			},
			{ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
		),
		mcpEnv,
		legacyLane.fetchMcp,
	)
	expect(legacyLane.calls).toBe(1)
	expect(modernResponse.status).toBe(200)
	const modernBody = (await modernResponse.json()) as {
		result: {
			tools: Array<{ name: string }>
		}
	}
	const tools = modernBody.result.tools
	expect(tools.map((tool) => tool.name).sort()).toEqual([
		'api',
		'execute',
		'search',
	])
	expect(dataPoints).toEqual([
		{
			indexes: ['legacy'],
			blobs: [
				'legacy',
				'initialize',
				'2025-06-18',
				'legacy-client',
				'1.0.0',
				'user',
				'example.com',
				'',
			],
			doubles: [1],
		},
		{
			indexes: ['modern'],
			blobs: [
				'modern',
				'tools/list',
				'2026-07-28',
				'modern-client',
				'2.0.0',
				'user',
				'example.com',
				'',
			],
			doubles: [1],
		},
	])
})

test('mcp request rejects unverified and unidentifiable accounts fail-closed', async () => {
	const request = bearerRequest()
	const transport = countingFetchMcp()

	// Account exists but email_verified_at is null.
	const unverifiedResponse = await callMcp(
		request,
		tokenEnv(mcpToken(), { emailVerifiedAt: null }),
		transport.fetchMcp,
	)
	expect(unverifiedResponse.status).toBe(403)
	expect(await unverifiedResponse.json()).toMatchObject({
		error: 'email_verification_required',
		error_description: expect.stringContaining('/account'),
	})

	// No matching account row at all, then grant props without an identifiable user.
	for (const token of [mcpToken(), mcpToken({ props: {} })]) {
		const response = await callMcp(request, tokenEnv(token), transport.fetchMcp)
		expect(response.status).toBe(403)
	}
	expect(transport.calls).toBe(0)

	// Verified but suspended accounts are rejected with a dedicated error, and
	// the rejection is recorded so a suspended principal that keeps calling
	// stays visible instead of failing silently.
	const auditInserts: Array<Array<unknown>> = []
	const suspendedResponse = await callMcp(
		request,
		tokenEnv(mcpToken(), { ...verified, auditInserts, suspendedAt: epoch }),
		transport.fetchMcp,
	)
	expect(suspendedResponse.status).toBe(403)
	expect(await suspendedResponse.json()).toMatchObject({
		error: 'account_suspended',
	})
	expect(transport.calls).toBe(0)
	expect(auditInserts).toHaveLength(1)
	// category, action, result, then the hashed email — never the raw address.
	expect(auditInserts[0]?.slice(0, 3)).toEqual([
		'auth',
		'mcp_token_rejected',
		'failure',
	])
	expect(auditInserts[0]).not.toContain('user@example.com')

	// Indexed stable-user-id lookup verifies accounts when grant props lack email.
	const fallbackEmail = 'fallback@example.com'
	const stableUserId = testStableUserIdFromEmail(fallbackEmail)
	const fallbackUserSelects: Array<string> = []
	const fallbackResponse = await callMcp(
		request,
		tokenEnv(mcpToken({ props: { userId: stableUserId } }), {
			accountByStableId: accountRow(11, fallbackEmail, stableUserId),
			userSelects: fallbackUserSelects,
		}),
		transport.fetchMcp,
	)
	expect(fallbackResponse.status).toBe(200)
	expect(transport.calls).toBe(1)
	expect(fallbackUserSelects).toHaveLength(1)
	expect(fallbackUserSelects[0]).toContain('email_verified_at')
	expect(fallbackUserSelects[0]).toContain('suspended_at')
	expect(fallbackUserSelects[0]).toContain('password_changed_at')
})

test('mcp request rejects access tokens issued before a password reset', async () => {
	const passwordChangedAt = '2026-08-29T15:00:00.000Z'
	const changedAtSeconds = Math.floor(Date.parse(passwordChangedAt) / 1000)
	const auditInserts: Array<Array<unknown>> = []
	const tokenCreatedAt = (createdAt: number) =>
		mcpToken({ createdAt, expiresAt: changedAtSeconds + 3600 })
	const transport = countingFetchMcp()

	const staleResponse = await callMcp(
		bearerRequest(),
		tokenEnv(tokenCreatedAt(changedAtSeconds - 60), {
			...verified,
			passwordChangedAt,
			auditInserts,
		}),
		transport.fetchMcp,
	)
	expect(staleResponse.status).toBe(401)
	expect(await staleResponse.json()).toEqual({
		error: 'invalid_token',
		error_description: mcpInvalidTokenDescription,
	})
	expect(transport.calls).toBe(0)
	expect(auditInserts[0]).toEqual(
		expect.arrayContaining(['auth', 'mcp_token_rejected', 'failure']),
	)

	const freshResponse = await callMcp(
		bearerRequest(),
		tokenEnv(tokenCreatedAt(changedAtSeconds + 1), {
			...verified,
			passwordChangedAt,
		}),
		transport.fetchMcp,
	)
	expect(freshResponse.status).toBe(200)
	expect(transport.calls).toBe(1)
})

test('mcp request heals a leftover UserMeter tombstone for a live account', async () => {
	const userId = ownerIdFromStored('leftover-meter-user')
	const email = 'leftover@example.com'
	const mcpEnv = tokenEnv(mcpToken({ userId, email }), {
		...verified,
		expectedEmail: email,
		expectedStableUserId: userId,
		accountByStableId: accountRow(21, email, userId),
	})
	const meter = userMeterRpc({ env: mcpEnv, userId })
	await meter.markDeleting({ deletingAt: '2026-08-31 15:22:12' })
	expect(await meter.readDeletionState()).toEqual({
		deletingAt: '2026-08-31 15:22:12',
	})

	const transport = countingFetchMcp()
	const response = await callMcp(bearerRequest(), mcpEnv, transport.fetchMcp)
	expect(response.status).toBe(200)
	expect(transport.calls).toBe(1)
	expect(await meter.readDeletionState()).toEqual({ deletingAt: null })
})

function instrumentWriteLeaseRpcs(namespace: Env['USER_METER']) {
	const calls: Array<string> = []
	return {
		calls,
		namespace: {
			idFromName: (name: string) => namespace.idFromName(name),
			get(id: DurableObjectId) {
				const target = namespace.get(id)
				return new Proxy(target, {
					get(_target, prop) {
						if (
							prop === 'acquireWriteLease' ||
							prop === 'assertWriteLeaseHeld' ||
							prop === 'releaseWriteLease'
						) {
							return async (args: unknown) => {
								calls.push(String(prop))
								return (
									target as unknown as Record<
										typeof prop,
										(args: unknown) => Promise<unknown>
									>
								)[prop](args)
							}
						}
						const value = (target as unknown as Record<PropertyKey, unknown>)[
							prop
						]
						if (typeof value === 'function') {
							return (...args: Array<unknown>) =>
								(
									target as unknown as Record<
										PropertyKey,
										(...args: Array<unknown>) => unknown
									>
								)[prop]!(...args)
						}
						return value
					},
				})
			},
		} as unknown as Env['USER_METER'],
	}
}

test('mcp write lease is scoped to mutating tools/call and still rejects deleting accounts', async () => {
	const userId = `lease-scope-${crypto.randomUUID()}`
	const email = 'lease-scope@example.com'
	const instrumented = instrumentWriteLeaseRpcs(env.USER_METER)
	const envForUser = (writableCheckDeletingAt?: string | null) =>
		tokenEnv(
			mcpToken({ userId, email }),
			{
				...verified,
				expectedEmail: email,
				expectedStableUserId: userId,
				writableCheckDeletingAt,
				accountByStableId: accountRow(31, email, userId),
			},
			{ USER_METER: instrumented.namespace },
		)
	const rpc = (id: number, call: Record<string, unknown>) => ({
		jsonrpc: '2.0',
		id,
		...call,
	})
	const listCall = { method: 'tools/list' }
	const searchCall = {
		method: 'tools/call',
		params: { name: 'search', arguments: { query: 'email' } },
	}
	const executeCall = {
		method: 'tools/call',
		params: { name: 'execute', arguments: { code: 'async () => 1' } },
	}

	const leaseCases: Array<[body: unknown, needsLease: boolean]> = [
		[undefined, true],
		[rpc(1, listCall), false],
		[rpc(2, searchCall), false],
		[rpc(3, executeCall), true],
		[
			[
				rpc(4, listCall),
				rpc(5, { method: 'tools/call', params: { name: 'execute' } }),
			],
			true,
		],
	]
	expect(
		leaseCases.filter(
			([body, needsLease]) =>
				mcpParsedBodyNeedsAccountWriteLease(body) !== needsLease,
		),
	).toEqual([])

	const transport = countingFetchMcp('legacy-ok')
	const leaseRpcs = ['acquireWriteLease', 'releaseWriteLease']
	for (const [call, expectedLeaseRpcs] of [
		[listCall, []],
		[searchCall, []],
		[executeCall, leaseRpcs],
	] as const) {
		instrumented.calls.length = 0
		const response = await callMcp(
			jsonRpcRequest(rpc(1, call)),
			envForUser(),
			transport.fetchMcp,
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('legacy-ok')
		expect(instrumented.calls).toEqual(expectedLeaseRpcs)
	}
	expect(transport.calls).toBe(3)

	instrumented.calls.length = 0
	for (const call of [searchCall, executeCall]) {
		const response = await callMcp(
			jsonRpcRequest(rpc(4, call)),
			envForUser('2026-09-02 00:00:00'),
			transport.fetchMcp,
		)
		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({ error: 'account_deleting' })
	}
	expect(instrumented.calls).toEqual([])
	expect(transport.calls).toBe(3)
})

test('successful mcp bearer validation records inbound connection last-used', async () => {
	const userId = `last-used-${crypto.randomUUID()}`
	const clientId = `https://cursor.com/oauth/${crypto.randomUUID()}/client.json`
	const email = `${userId}@example.com`
	const mcpEnv = tokenEnv(mcpToken({ userId, email, clientId }), {
		...verified,
		expectedEmail: email,
		expectedStableUserId: userId,
	})
	const listLastUsed = () =>
		userMeterRpc({
			env: mcpEnv,
			userId: ownerIdFromStored(userId),
		}).listInboundConnectionLastUsed()

	expect((await callMcp(bearerRequest(), mcpEnv)).status).toBe(200)
	const rows = await listLastUsed()
	expect(rows).toHaveLength(1)
	expect(rows[0]?.clientId).toBe(clientId)
	const usedAt = Date.parse(rows[0]?.lastUsedAt ?? '')
	expect(Number.isFinite(usedAt)).toBe(true)
	expect(Math.abs(Date.now() - usedAt)).toBeLessThan(15_000)

	expect((await callMcp(bearerRequest(), mcpEnv)).status).toBe(200)
	expect(await listLastUsed()).toEqual(rows)
}, 30_000)
