import { expect, test } from 'vitest'
import {
	buildMcpClientIdMetadataDocument,
	createMcpClientOAuthProvider,
	handleMcpClientIdMetadataRequest,
	mcpClientIdMetadataPath,
	mcpClientName,
	resolveMcpClientMetadataUrl,
	resolveMcpOAuthClientMode,
} from './client-id-metadata.ts'
import {
	buildMcpOAuthAttemptIdentity,
	markMcpOAuthAttemptVerified,
	mcpOAuthAttemptStorageKey,
	mcpOAuthAttemptVerifiedStorageKey,
	McpOAuthAttemptIdentityError,
	writeMcpOAuthAttemptIdentity,
} from './oauth-attempt.ts'
import {
	McpOAuthFailedError,
	mcpOAuthFailedCode,
} from './oauth-issuer-endpoints.ts'
import {
	mcpOAuthRefreshGrantOmittedStorageKey,
	mcpOAuthRefreshTokenStorageKey,
} from './oauth-token-recovery.ts'

const callbackUrl = 'https://kody.codes/account/mcp-servers/oauth/callback'
const tokenKey = '/Kody/server-home/client-1/token'
const refreshKey = mcpOAuthRefreshTokenStorageKey('server-home')

test('CIMD resolves only for HTTPS, serves the origin-bound document, and wires the OAuth provider', async () => {
	const origin = 'https://kody.codes'
	const documentUrl = `${origin}${mcpClientIdMetadataPath}`
	expect(resolveMcpClientMetadataUrl(callbackUrl)).toBe(documentUrl)
	expect(
		resolveMcpClientMetadataUrl(
			'http://localhost:8787/account/mcp-servers/oauth/callback',
		),
	).toBeUndefined()
	expect(resolveMcpClientMetadataUrl('not-a-url')).toBeUndefined()

	const document = buildMcpClientIdMetadataDocument(`${origin}/ignored`)
	expect(document.client_id).toBe(documentUrl)
	expect(document.client_uri).toBe(origin)
	expect(document.client_name).toBe(mcpClientName)
	expect(document.redirect_uris).toEqual([callbackUrl])
	expect(document.token_endpoint_auth_method).toBe('none')

	const handle = (method: string, url = documentUrl) =>
		handleMcpClientIdMetadataRequest(new Request(url, { method }))
	const getResponse = handle('GET')
	expect(getResponse?.status).toBe(200)
	expect(getResponse?.headers.get('Content-Type')).toBe('application/json')
	expect(await getResponse?.json()).toMatchObject({
		client_id: documentUrl,
		redirect_uris: [callbackUrl],
	})
	const headResponse = handle('HEAD')
	expect(headResponse?.status).toBe(200)
	expect(await headResponse?.text()).toBe('')
	expect(handle('OPTIONS')?.status).toBe(204)
	expect(handle('GET', `${origin}/oauth/authorize`)).toBeNull()
	expect(handle('POST')).toBeNull()

	const storage = {} as DurableObjectStorage
	const httpsProvider = createMcpClientOAuthProvider(storage, callbackUrl)
	expect(httpsProvider.clientMetadataUrl).toBe(documentUrl)
	expect(httpsProvider.clientMetadata.redirect_uris).toEqual([callbackUrl])
	expect(
		createMcpClientOAuthProvider(
			storage,
			'http://127.0.0.1:8787/account/mcp-servers/oauth/callback',
		).clientMetadataUrl,
	).toBeUndefined()
})

function createMemoryStorage() {
	const values = new Map<string, unknown>()
	const hooks: {
		afterPut?: (key: string, value: unknown) => Promise<void>
	} = {}
	const storage = {
		put: async (key: string, value: unknown) => {
			values.set(key, value)
			await hooks.afterPut?.(key, value)
		},
		get: async (key: string) => values.get(key),
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) {
				values.delete(item)
			}
		},
		list: async ({ prefix }: { prefix?: string } = {}) =>
			new Map(
				[...values.entries()].filter(([key]) =>
					prefix ? key.startsWith(prefix) : true,
				),
			),
	} as unknown as DurableObjectStorage
	return { storage, values, hooks }
}

function makeProvider(storage: DurableObjectStorage, clientId?: string) {
	const provider = createMcpClientOAuthProvider(storage, callbackUrl)
	provider.serverId = 'server-home'
	if (clientId) provider.clientId = clientId
	return provider
}

function bearer(access_token: string, refresh_token?: string) {
	return {
		access_token,
		...(refresh_token ? { refresh_token } : {}),
		token_type: 'Bearer',
	}
}

test('OAuth provider saveTokens keeps a refresh token and discovery when the AS omits them', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')
	await provider.saveDiscoveryState({
		authorization_servers: ['https://auth.example'],
	} as never)
	await provider.saveTokens(bearer('first-at', 'keep-rt'))
	expect(values.get(tokenKey)).toEqual(bearer('first-at', 'keep-rt'))
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'keep-rt' })

	await provider.saveTokens(bearer('refreshed-at'))
	expect(values.get(tokenKey)).toEqual(bearer('refreshed-at', 'keep-rt'))
	expect(values.get('/Kody/server-home/oauth_discovery')).toEqual({
		authorization_servers: ['https://auth.example'],
	})

	await Promise.all([
		provider.saveTokens(bearer('race-a')),
		provider.saveTokens(bearer('race-b')),
	])
	expect(values.get(tokenKey)).toMatchObject({ refresh_token: 'keep-rt' })

	const restored = makeProvider(storage)
	expect(await restored.tokens()).toMatchObject({ refresh_token: 'keep-rt' })
	expect(restored.clientId).toBe('client-1')

	await restored.invalidateCredentials('tokens')
	expect(values.get(tokenKey)).toBeUndefined()
	expect(values.get(refreshKey)).toBeUndefined()
	expect(await restored.tokens()).toBeUndefined()
})

test('CIMD grant stores under the metadata URL and drops a leftover DCR sibling so tokens() sees the refresh token', async () => {
	const { storage, values } = createMemoryStorage()
	const cimdClientId = `https://kody.codes${mcpClientIdMetadataPath}`
	const dcrKey = '/Kody/server-home/dcr-stale/token'
	const cimdKey = `/Kody/server-home/${cimdClientId}/token`
	values.set(dcrKey, bearer('stale-at'))

	const live = {
		serverId: 'server-home',
		serverUrl: 'https://beeper.example/mcp',
		clientId: cimdClientId,
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'beeper',
	}
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => live,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'dcr-stale'
	await provider.saveDiscoveryState({
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			grant_types_supported: ['authorization_code', 'refresh_token'],
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		},
	} as never)

	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: cimdClientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: {
			authorizationServerUrl: 'https://auth.example',
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
			},
		},
	})
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	await provider.saveTokens(bearer('grant-at', 'grant-rt'))

	expect(values.get(dcrKey)).toBeUndefined()
	expect(values.get(cimdKey)).toMatchObject({
		access_token: 'grant-at',
		refresh_token: 'grant-rt',
	})
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'grant-rt' })
	expect(values.get(mcpOAuthRefreshGrantOmittedStorageKey('server-home'))).toBe(
		undefined,
	)
	expect(provider.clientId).toBe(cimdClientId)
	expect(await provider.tokens()).toMatchObject({
		access_token: 'grant-at',
		refresh_token: 'grant-rt',
	})
})

test('failed authorization-code saveTokens keeps the prior grant and DCR sibling', async () => {
	const { storage, values } = createMemoryStorage()
	const cimdClientId = `https://kody.codes${mcpClientIdMetadataPath}`
	const dcrKey = '/Kody/server-home/dcr-stale/token'
	const cimdKey = `/Kody/server-home/${cimdClientId}/token`
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://beeper.example/mcp',
		clientId: cimdClientId,
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'beeper',
	}
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => live,
	})
	provider.serverId = 'server-home'
	provider.clientId = cimdClientId
	await provider.saveDiscoveryState({
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		},
	} as never)
	await provider.saveTokens(bearer('old-at', 'old-rt'))
	values.set(dcrKey, bearer('stale-at', 'stale-rt'))

	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: cimdClientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: {
			authorizationServerUrl: 'https://auth.example',
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
			},
		},
	})
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')

	const originalPut = storage.put.bind(storage)
	storage.put = (async (key: string, value: unknown) => {
		if (key === cimdKey) {
			throw new Error('simulated token write failure')
		}
		return originalPut(key, value)
	}) as typeof storage.put

	await expect(provider.saveTokens(bearer('new-at', 'new-rt'))).rejects.toThrow(
		'simulated token write failure',
	)
	expect(values.get(cimdKey)).toMatchObject({
		access_token: 'old-at',
		refresh_token: 'old-rt',
	})
	expect(values.get(dcrKey)).toMatchObject({
		access_token: 'stale-at',
		refresh_token: 'stale-rt',
	})
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'old-rt' })
})

test('re-authorize redirect keeps the live grant until the new authorization-code save clears siblings', async () => {
	const { storage, values } = createMemoryStorage()
	const cimdClientId = `https://kody.codes${mcpClientIdMetadataPath}`
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://beeper.example/mcp',
		clientId: cimdClientId,
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'beeper',
	}
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => live,
	})
	provider.serverId = 'server-home'
	provider.clientId = cimdClientId
	await provider.saveDiscoveryState({
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		},
	} as never)
	await provider.saveTokens(bearer('old-at', 'old-rt'))
	values.set(
		'/Kody/server-home/dcr-stale/token',
		bearer('stale-at', 'stale-rt'),
	)

	const authUrl = new URL('https://auth.example/authorize')
	authUrl.searchParams.set('client_id', cimdClientId)
	authUrl.searchParams.set('state', 'nonce.server-home')
	authUrl.searchParams.set('code_challenge', 'challenge')
	await provider.redirectToAuthorization(authUrl)

	// Redirect alone must not wipe a recoverable grant (SDK may redirect after
	// a transient refresh failure). Sibling cleanup happens on code exchange.
	expect(values.get(`/Kody/server-home/${cimdClientId}/token`)).toMatchObject({
		access_token: 'old-at',
		refresh_token: 'old-rt',
	})
	expect(values.get('/Kody/server-home/dcr-stale/token')).toMatchObject({
		access_token: 'stale-at',
		refresh_token: 'stale-rt',
	})
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'old-rt' })
	expect(await provider.tokens()).toMatchObject({
		access_token: 'old-at',
		refresh_token: 'old-rt',
	})

	await markMcpOAuthAttemptVerified(storage, 'server-home')
	await provider.saveTokens(bearer('new-at', 'new-rt'))
	expect(values.get('/Kody/server-home/dcr-stale/token')).toBeUndefined()
	expect(values.get(`/Kody/server-home/${cimdClientId}/token`)).toMatchObject({
		access_token: 'new-at',
		refresh_token: 'new-rt',
	})
})

test('authorization-code grant without a refresh token clears the prior sidecar', async () => {
	const { storage, values } = createMemoryStorage()
	const cimdClientId = `https://kody.codes${mcpClientIdMetadataPath}`
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://beeper.example/mcp',
		clientId: cimdClientId,
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'beeper',
	}
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => live,
	})
	provider.serverId = 'server-home'
	provider.clientId = cimdClientId
	await provider.saveDiscoveryState({
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			grant_types_supported: ['authorization_code', 'refresh_token'],
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		},
	} as never)
	await provider.saveTokens(bearer('old-at', 'old-rt'))
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'old-rt' })

	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: cimdClientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: {
			authorizationServerUrl: 'https://auth.example',
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
				grant_types_supported: ['authorization_code', 'refresh_token'],
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
			},
		},
	})
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	await provider.saveTokens(bearer('access-only'))

	expect(values.get(refreshKey)).toBeUndefined()
	expect(
		values.get(mcpOAuthRefreshGrantOmittedStorageKey('server-home')),
	).toMatchObject({ omitted: true })
	expect(await provider.tokens()).toMatchObject({
		access_token: 'access-only',
	})
	expect(await provider.tokens()).not.toHaveProperty('refresh_token')
})

test('saveTokens records an omitted advertised refresh grant and clears it when a refresh token arrives', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')
	const omitKey = mcpOAuthRefreshGrantOmittedStorageKey('server-home')
	await provider.saveDiscoveryState({
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			grant_types_supported: ['authorization_code', 'refresh_token'],
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		},
	} as never)

	await provider.saveTokens(bearer('access-only'))
	expect(values.get(omitKey)).toMatchObject({ omitted: true })
	expect(values.get(tokenKey)).toEqual(bearer('access-only'))
	expect(values.get(refreshKey)).toBeUndefined()

	await provider.saveTokens(bearer('with-rt', 'rt-1'))
	expect(values.get(omitKey)).toBeUndefined()
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'rt-1' })
})

test('OAuth invalidate infers a missing client id, drops leftover token blobs, and keeps a newer rotated grant', async () => {
	const { storage, values, hooks } = createMemoryStorage()
	await makeProvider(storage, 'client-1').saveTokens(bearer('old-at', 'old-rt'))
	values.set(
		'/Kody/server-home/client-stale/token',
		bearer('stale-at', 'stale-rt'),
	)

	const restored = makeProvider(storage)
	await restored.invalidateCredentials('tokens')
	expect(values.get(tokenKey)).toBeUndefined()
	expect(values.get('/Kody/server-home/client-stale/token')).toBeUndefined()
	expect(values.get(refreshKey)).toBeUndefined()
	expect(await restored.tokens()).toBeUndefined()

	const rotating = makeProvider(storage, 'client-1')
	await rotating.saveTokens(bearer('live-at', 'live-rt'))

	const { promise: blockSave, resolve: releaseSave } =
		Promise.withResolvers<void>()
	const { promise: saveStarted, resolve: markSaveStarted } =
		Promise.withResolvers<void>()
	hooks.afterPut = async (key, value) => {
		if (
			key === refreshKey &&
			(value as { refresh_token?: string } | undefined)?.refresh_token ===
				'rotated-rt'
		) {
			markSaveStarted()
			await blockSave
		}
	}

	const saveRotated = rotating.saveTokens(bearer('rotated-at', 'rotated-rt'))
	await saveStarted
	const staleInvalidate = rotating.invalidateCredentials('tokens')
	releaseSave()
	await Promise.all([saveRotated, staleInvalidate])

	expect(values.get(tokenKey)).toMatchObject({
		access_token: 'rotated-at',
		refresh_token: 'rotated-rt',
	})
	expect(values.get(refreshKey)).toEqual({ refresh_token: 'rotated-rt' })
	expect(await rotating.tokens()).toMatchObject({
		refresh_token: 'rotated-rt',
	})
})

test('client mode reads the client_id the authorization URL carries', () => {
	const authorize = (clientId: string) =>
		`https://auth.example/authorize?${new URLSearchParams({ client_id: clientId, state: 'nonce.server-home' })}`
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize(
				`https://kody.codes${mcpClientIdMetadataPath}`,
			),
			callbackUrl,
		}),
	).toBe('cimd')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize('registered-client-1'),
			callbackUrl,
		}),
	).toBe('dcr')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize(
				`https://kody.codes${mcpClientIdMetadataPath}`,
			),
			callbackUrl: 'http://localhost:8787/account/mcp-servers/oauth/callback',
		}),
	).toBe('dcr')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize('github-app-client'),
			callbackUrl,
			preRegisteredClientId: 'github-app-client',
		}),
	).toBe('pre-registered')
	expect(
		resolveMcpOAuthClientMode({
			authorizationUrl: authorize('registered-client-1'),
			callbackUrl,
			preRegisteredClientId: 'github-app-client',
		}),
	).toBe('dcr')
})

const discoveryOnIssuer = {
	authorizationServerUrl: 'https://auth.example',
	authorizationServerMetadata: {
		issuer: 'https://auth.example',
		authorization_endpoint: 'https://auth.example/authorize',
		token_endpoint: 'https://auth.example/token',
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
	},
}

function asDiscoveryMetadata(overrides: Record<string, unknown> = {}) {
	return {
		authorizationServerUrl: 'https://auth.example',
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			...overrides,
		},
	}
}

const offIssuerSite = (field: string) =>
	new RegExp(
		`${mcpOAuthFailedCode}[\\s\\S]*${field} .*not on its issuer's origin or registrable domain`,
	)
const issuerNotEchoed = new RegExp(
	`${mcpOAuthFailedCode}[\\s\\S]*issuer .*does not match the discovered authorization server`,
)

test('OAuth provider refuses discovery whose authorize or token endpoint leaves the issuer site (#3284)', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')

	await expect(
		provider.saveDiscoveryState(
			asDiscoveryMetadata({
				authorization_endpoint: 'https://evil.example/authorize',
			}) as never,
		),
	).rejects.toThrow(McpOAuthFailedError)
	await expect(
		provider.saveDiscoveryState(
			asDiscoveryMetadata({
				token_endpoint: 'https://evil.example/token',
			}) as never,
		),
	).rejects.toThrow(offIssuerSite('token_endpoint'))
	await expect(
		provider.saveDiscoveryState({
			authorizationServerUrl: 'https://a.github.io',
			authorizationServerMetadata: {
				issuer: 'https://a.github.io',
				authorization_endpoint: 'https://b.github.io/authorize',
				token_endpoint: 'https://a.github.io/token',
			},
		} as never),
	).rejects.toThrow(offIssuerSite('authorization_endpoint'))
	expect(values.get('/Kody/server-home/oauth_discovery')).toBeUndefined()

	await provider.saveDiscoveryState(asDiscoveryMetadata() as never)
	expect(values.get('/Kody/server-home/oauth_discovery')).toMatchObject({
		authorizationServerUrl: 'https://auth.example',
	})
})

test('OAuth provider saves and re-reads sibling-host discovery on one registrable domain (Slack, Datadog, Figma)', async () => {
	for (const discovery of [
		{
			authorizationServerUrl: 'https://mcp.slack.com/',
			authorizationServerMetadata: {
				issuer: 'https://mcp.slack.com',
				authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
				token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
			},
		},
		{
			authorizationServerUrl: 'https://mcp.us5.datadoghq.com/v1/mcp',
			authorizationServerMetadata: {
				issuer: 'https://mcp.us5.datadoghq.com/v1/mcp',
				authorization_endpoint: 'https://us5.datadoghq.com/oauth2/v1/authorize',
				token_endpoint: 'https://us5.datadoghq.com/api/v2/oauth2/token',
				registration_endpoint:
					'https://us5.datadoghq.com/api/v2/oauth2/register',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
			},
		},
		{
			authorizationServerUrl: 'https://api.figma.com/',
			authorizationServerMetadata: {
				issuer: 'https://api.figma.com',
				authorization_endpoint: 'https://www.figma.com/oauth/mcp',
				token_endpoint: 'https://api.figma.com/v1/oauth/token',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
				authorization_response_iss_parameter_supported: true,
			},
		},
	]) {
		const { storage, values } = createMemoryStorage()
		const provider = makeProvider(storage, 'client-1')
		await provider.saveDiscoveryState(discovery as never)
		expect(values.get('/Kody/server-home/oauth_discovery')).toEqual(discovery)
		expect(await provider.discoveryState()).toEqual(discovery)
	}
})

test('OAuth provider refuses discovery whose issuer does not echo the discovered AS URL (RFC 8414)', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')

	await expect(
		provider.saveDiscoveryState({
			...asDiscoveryMetadata({
				issuer: 'https://evil.example',
				authorization_endpoint: 'https://evil.example/authorize',
				token_endpoint: 'https://evil.example/token',
			}),
			authorizationServerUrl: 'https://auth.example',
		} as never),
	).rejects.toThrow(issuerNotEchoed)
	await expect(
		provider.saveDiscoveryState({
			...asDiscoveryMetadata(),
			authorizationServerUrl: 'https://auth.example/tenant',
		} as never),
	).rejects.toThrow(issuerNotEchoed)
	expect(values.get('/Kody/server-home/oauth_discovery')).toBeUndefined()

	await provider.saveDiscoveryState({
		...asDiscoveryMetadata(),
		authorizationServerUrl: 'https://auth.example/',
	} as never)
	expect(values.get('/Kody/server-home/oauth_discovery')).toMatchObject({
		authorizationServerUrl: 'https://auth.example/',
	})
})

test('OAuth provider refresh path re-asserts the issuer site on cached discovery (#3284)', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')
	// Pre-check / tampered cache: write past saveDiscoveryState.
	values.set(
		'/Kody/server-home/oauth_discovery',
		asDiscoveryMetadata({
			token_endpoint: 'https://evil.example/token',
		}),
	)

	await expect(provider.discoveryState()).rejects.toThrow(
		offIssuerSite('token_endpoint'),
	)

	values.set('/Kody/server-home/oauth_discovery', {
		authorizationServerUrl: 'https://a.workers.dev',
		authorizationServerMetadata: {
			issuer: 'https://a.workers.dev',
			authorization_endpoint: 'https://a.workers.dev/authorize',
			token_endpoint: 'https://b.workers.dev/token',
		},
	})
	await expect(provider.discoveryState()).rejects.toThrow(
		offIssuerSite('token_endpoint'),
	)
})

test('OAuth provider refresh path refuses cached discovery whose issuer does not echo the AS URL (RFC 8414)', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, 'client-1')
	// Cached before the issuer-echo check shipped: same-origin endpoints, wrong issuer.
	values.set('/Kody/server-home/oauth_discovery', {
		...asDiscoveryMetadata({
			issuer: 'https://other.example',
			authorization_endpoint: 'https://other.example/authorize',
			token_endpoint: 'https://other.example/token',
		}),
		authorizationServerUrl: 'https://auth.example',
	})
	await expect(provider.discoveryState()).rejects.toThrow(issuerNotEchoed)

	values.set('/Kody/server-home/oauth_discovery', {
		authorizationServerMetadata:
			asDiscoveryMetadata().authorizationServerMetadata,
	})
	await expect(provider.discoveryState()).rejects.toThrow(McpOAuthFailedError)

	values.set('/Kody/server-home/oauth_discovery', asDiscoveryMetadata())
	expect(await provider.discoveryState()).toEqual(asDiscoveryMetadata())
})

test('OAuth attempt identity: happy path, remove/re-add, client mismatch, and refresh without pending', async () => {
	const { storage, values } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'

	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	expect(pending).not.toBeNull()
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	await provider.saveTokens(bearer('grant-at', 'grant-rt'))
	expect(values.get(tokenKey)).toEqual(bearer('grant-at', 'grant-rt'))
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()
	expect(
		values.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()

	// Refresh / later saves without a pending attempt still work (existing grants).
	await provider.saveTokens(bearer('refreshed-at'))
	expect(values.get(tokenKey)).toEqual(bearer('refreshed-at', 'grant-rt'))

	// Refresh while an attempt is pending (not yet verified) must not clear it.
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await provider.saveTokens(bearer('refresh-during-attempt'))
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toEqual(pending)

	// Remove and re-add mid-flow: new stable id, nothing saved from the old attempt.
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	currentLive = {
		...live,
		serverId: 'server-readded',
	}
	await expect(
		provider.saveTokens(bearer('stolen-at', 'stolen-rt')),
	).rejects.toBeInstanceOf(McpOAuthAttemptIdentityError)
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()

	// Client replaced mid-flow.
	currentLive = { ...live }
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	currentLive = { ...live, clientId: 'other-client' }
	await expect(
		provider.saveTokens(bearer('other-at', 'other-rt')),
	).rejects.toThrow(/Reconnect at \/account\/mcp-servers/)
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)

	// Person mismatch mid-flow.
	currentLive = { ...live }
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')
	currentLive = { ...live, personId: 'person-other' }
	await expect(
		provider.saveTokens(bearer('person-at', 'person-rt')),
	).rejects.toBeInstanceOf(McpOAuthAttemptIdentityError)
	expect(values.get(tokenKey)).toEqual(
		bearer('refresh-during-attempt', 'grant-rt'),
	)
})

test('checkState fails closed when the live server no longer matches the attempt', async () => {
	const { storage } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	const state = await provider.state()
	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await provider.saveDiscoveryState(discoveryOnIssuer as never)

	expect(await provider.checkState(state)).toMatchObject({
		valid: true,
		serverId: 'server-home',
	})
	expect(
		await storage.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toMatchObject({ verifiedAt: expect.any(Number) })

	currentLive = null
	const refused = await provider.checkState(state)
	expect(refused.valid).toBe(false)
	expect(refused.error).toMatch(/Reconnect at \/account\/mcp-servers/)
	expect(
		await storage.get(mcpOAuthAttemptStorageKey('server-home')),
	).toBeUndefined()
	expect(
		await storage.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()
})

test('a verified pending attempt survives an actor-less refresh race during grant save', async () => {
	const { storage, values } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1' as string | null,
		personId: 'person-1' as string | null,
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	const pending = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId!,
		personId: live.personId!,
		discovery: discoveryOnIssuer,
	})
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	// Existing grant so an actor-less refresh has a refresh_token to preserve.
	await provider.saveTokens(bearer('seed-at', 'seed-rt'))
	await writeMcpOAuthAttemptIdentity(storage, pending!)
	await markMcpOAuthAttemptVerified(storage, 'server-home')

	// Actor-less refresh (no ownerOrgId/personId) during the verified window
	// must still save — otherwise a failed code exchange wedges every later
	// refresh while verified stays set. Leave the attempt alone for the grant.
	currentLive = { ...live, ownerOrgId: null, personId: null }
	await provider.saveTokens(bearer('refresh-at'))
	expect(values.get(tokenKey)).toEqual(bearer('refresh-at', 'seed-rt'))
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toEqual(pending)
	expect(
		values.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toMatchObject({ verifiedAt: expect.any(Number) })

	currentLive = { ...live }
	await provider.saveTokens(bearer('grant-at', 'grant-rt'))
	expect(values.get(tokenKey)).toEqual(bearer('grant-at', 'grant-rt'))
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()
	expect(
		values.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()
})

test('redirectToAuthorization validates, commits SDK state, then stamps identity', async () => {
	const { storage, values } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1' as string | null,
		personId: 'person-1' as string | null,
		name: 'docs',
	}
	let currentLive: typeof live | null = { ...live }
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	const authUrl = new URL('https://auth.example/authorize')
	authUrl.searchParams.set('client_id', 'client-1')
	authUrl.searchParams.set('state', 'nonce.server-home')
	authUrl.searchParams.set('code_challenge', 'challenge')

	await provider.redirectToAuthorization(authUrl)
	expect(provider.authUrl).toBe(authUrl.toString())
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toMatchObject({
		serverId: 'server-home',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
	})

	// Actor-less / incomplete live identity must refuse before the SDK commit.
	currentLive = { ...live, ownerOrgId: null, personId: null }
	values.delete(mcpOAuthAttemptStorageKey('server-home'))
	const providerAgain = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => currentLive,
	})
	providerAgain.serverId = 'server-home'
	providerAgain.clientId = 'client-1'
	await expect(
		providerAgain.redirectToAuthorization(authUrl),
	).rejects.toBeInstanceOf(McpOAuthAttemptIdentityError)
	expect(providerAgain.authUrl).toBeUndefined()
	expect(values.get(mcpOAuthAttemptStorageKey('server-home'))).toBeUndefined()

	// Storage failure after SDK commit must clear authUrl so callers do not
	// send the person through consent for an unwired attempt.
	currentLive = { ...live }
	const failingStorage = {
		...storage,
		put: async () => {
			throw new Error('storage put failed')
		},
	} as unknown as DurableObjectStorage
	const providerFailWrite = createMcpClientOAuthProvider(
		failingStorage,
		callbackUrl,
		{ resolveLiveServerIdentity: async () => currentLive },
	)
	providerFailWrite.serverId = 'server-home'
	providerFailWrite.clientId = 'client-1'
	await expect(
		providerFailWrite.redirectToAuthorization(authUrl),
	).rejects.toThrow(/storage put failed/)
	expect(providerFailWrite.authUrl).toBeUndefined()
})

test('checkState refuses when a concurrent redirect replaces the pending attempt', async () => {
	const { storage } = createMemoryStorage()
	const live = {
		serverId: 'server-home',
		serverUrl: 'https://mcp.example/mcp',
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	const original = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: live.clientId,
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	const replaced = buildMcpOAuthAttemptIdentity({
		serverId: live.serverId,
		serverUrl: live.serverUrl,
		clientId: 'client-replaced',
		ownerOrgId: live.ownerOrgId,
		personId: live.personId,
		discovery: discoveryOnIssuer,
	})
	await writeMcpOAuthAttemptIdentity(storage, original!)
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolveLiveServerIdentity: async () => {
			await writeMcpOAuthAttemptIdentity(storage, replaced!)
			return { ...live, clientId: 'client-replaced' }
		},
	})
	provider.serverId = 'server-home'
	provider.clientId = 'client-1'
	await provider.saveDiscoveryState(discoveryOnIssuer as never)
	const state = await provider.state()

	const refused = await provider.checkState(state)
	expect(refused.valid).toBe(false)
	expect(refused.error).toMatch(/Reconnect at \/account\/mcp-servers/)
	expect(
		await storage.get(mcpOAuthAttemptStorageKey('server-home')),
	).toBeUndefined()
	expect(
		await storage.get(mcpOAuthAttemptVerifiedStorageKey('server-home')),
	).toBeUndefined()
})
