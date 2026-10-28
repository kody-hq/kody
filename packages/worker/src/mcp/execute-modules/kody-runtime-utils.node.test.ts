import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	type CapabilityArgs,
	type KodyNamespace,
	type ExecuteRequestInput,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	oauthClientCredentials,
	type secretHeaders,
} from './kody-runtime-utils.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

type SandboxHelpers = {
	createAuthenticatedFetch: (
		providerName: string,
	) => Promise<
		(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
	>
	secretHeaders: typeof secretHeaders
	oauthClientCredentials: typeof oauthClientCredentials
}

type RecordedRequest = Pick<Request, 'url' | 'headers'>

type ApiResponseSpec = {
	status: number
	body?: Record<string, unknown> | string
	contentType?: string
	url?: string
}

type TestIntegration = {
	name: string
	tokenUrl: string
	apiBaseUrl: string
	flow: 'pkce' | 'confidential'
	clientId: string
	requiredHosts: Array<string>
	platform?: boolean
}

const spotifyIntegration: TestIntegration = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.test/api/token',
	apiBaseUrl: 'https://api.spotify.test/v1',
	flow: 'pkce',
	clientId: 'spotify-client-id',
	requiredHosts: ['api.spotify.test'],
}

const githubPlatformIntegration: TestIntegration = {
	name: 'github',
	tokenUrl: 'https://github.test/login/oauth/access_token',
	apiBaseUrl: 'https://api.github.test',
	flow: 'confidential',
	clientId: 'platform-github-client-id',
	requiredHosts: ['api.github.test'],
	platform: true,
}

const slackIntegration: TestIntegration = {
	name: 'slack',
	tokenUrl: 'https://slack.test/api/oauth.v2.access',
	apiBaseUrl: 'https://slack.com/api',
	flow: 'confidential',
	clientId: 'slack-client',
	requiredHosts: ['slack.com', 'files.slack.com'],
}

function createKody(
	integration: TestIntegration,
	refreshResult: Record<string, unknown> = {
		ok: true,
		refreshed: true,
		skippedReason: null,
		refreshedAt: new Date().toISOString(),
		refreshTokenRotated: false,
	},
) {
	const tokenRefreshCalls: Array<CapabilityArgs> = []
	const kody = {
		async integrationGet(args: CapabilityArgs) {
			expect(args.name).toBe(integration.name)
			return { integration }
		},
		async integrationTokenRefresh(args: CapabilityArgs) {
			tokenRefreshCalls.push(args)
			return refreshResult
		},
	} satisfies KodyNamespace
	return { kody, tokenRefreshCalls }
}

const createSandboxHelpers = new Function(
	'__kodyCallDispatcher',
	`${createExecuteHelperPrelude()}; return { createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
) as (
	dispatch: (name: string, args: CapabilityArgs) => Promise<unknown>,
) => SandboxHelpers

function dispatchFor(kody: KodyNamespace) {
	return async (name: string, args: CapabilityArgs) => {
		const tool = kody[name]
		if (typeof tool !== 'function') {
			throw new Error(`${name} is not available in this sandbox.`)
		}
		return await tool(args)
	}
}

function createFetchMock(options: {
	fetchCalls: Array<RecordedRequest>
	apiErrors: Array<Error>
	apiResponses: Array<ApiResponseSpec>
}) {
	const apiErrors = [...options.apiErrors]
	const apiResponses = [...options.apiResponses]
	const originalFetch = globalThis.fetch
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		options.fetchCalls.push(request.clone())
		const apiError = apiErrors.shift()
		if (apiError) throw apiError
		const apiResponse = apiResponses.shift()
		const status = apiResponse?.status ?? 200
		const contentType =
			apiResponse?.contentType ??
			(typeof apiResponse?.body === 'string'
				? 'text/plain'
				: 'application/json')
		const body =
			apiResponse?.body === undefined
				? JSON.stringify({ ok: true })
				: typeof apiResponse.body === 'string'
					? apiResponse.body
					: JSON.stringify(apiResponse.body)
		const response = new Response(body, {
			status,
			headers: { 'content-type': contentType },
		})
		if (apiResponse?.url) {
			Object.defineProperty(response, 'url', {
				value: apiResponse.url,
				configurable: true,
			})
		}
		return response
	}
	return {
		[Symbol.dispose]() {
			globalThis.fetch = originalFetch
		},
	}
}

function authenticatedFetchImplementations(
	integration: TestIntegration,
	kody: KodyNamespace,
) {
	return {
		host: () => createAuthenticatedFetch(kody, integration.name),
		sandbox: () =>
			createSandboxHelpers(dispatchFor(kody)).createAuthenticatedFetch(
				integration.name,
			),
	}
}

test('createAuthenticatedFetch uses placeholder auth and refreshes host-side on missing or expired tokens', async () => {
	const expired = [
		{ status: 401, body: { error: 'expired' } },
		{ status: 200, body: { ok: true } },
	]
	// Every attempt uses the placeholder header: the raw token never enters
	// the sandbox even on the post-refresh retry.
	const scenarios = [
		{
			label: 'stored token',
			integration: spotifyIntegration,
			path: '/me/playlists',
			init: { method: 'POST' },
			apiErrors: [],
			apiResponses: [],
			urls: ['https://api.spotify.test/v1/me/playlists'],
		},
		{
			label: 'missing token',
			integration: spotifyIntegration,
			path: '/me?market=US',
			apiErrors: [
				new Error('Integration "spotify" does not have a stored access token.'),
			],
			apiResponses: [],
			urls: Array(2).fill('https://api.spotify.test/v1/me?market=US'),
		},
		{
			label: 'expired token',
			integration: spotifyIntegration,
			path: '/me?market=US',
			apiErrors: [],
			apiResponses: expired,
			urls: Array(2).fill('https://api.spotify.test/v1/me?market=US'),
		},
		{
			label: 'expired platform token',
			integration: githubPlatformIntegration,
			path: '/user',
			apiErrors: [],
			apiResponses: expired,
			urls: Array(2).fill('https://api.github.test/user'),
		},
	]
	for (const scenario of scenarios) {
		const { name } = scenario.integration
		const fetchCalls: Array<RecordedRequest> = []
		const { kody, tokenRefreshCalls } = createKody(scenario.integration)
		{
			// Native Response bodies avoid hanging when 401 retry cancels one.
			using _fetchMock = createFetchMock({ fetchCalls, ...scenario })
			const authenticatedFetch = await createAuthenticatedFetch(kody, name)
			const response = await authenticatedFetch(scenario.path, scenario.init)
			expect(await response.json()).toEqual({ ok: true })
		}
		expect({
			label: scenario.label,
			tokenRefreshCalls,
			requests: fetchCalls.map((request) => [
				request.url,
				request.headers.get('authorization'),
			]),
		}).toEqual({
			label: scenario.label,
			tokenRefreshCalls: scenario.urls.length > 1 ? [{ name }] : [],
			requests: scenario.urls.map((url) => [
				url,
				`Bearer {{integration-token:${name}}}`,
			]),
		})
	}
})

test('createAuthenticatedFetch returns the original 401 without a retry when the connection has nothing to refresh', async () => {
	const implementations = {
		host: (kody: KodyNamespace) => createAuthenticatedFetch(kody, 'spotify'),
		sandbox: (kody: KodyNamespace) =>
			createSandboxHelpers(dispatchFor(kody)).createAuthenticatedFetch(
				'spotify',
			),
	}
	for (const [label, create] of Object.entries(implementations)) {
		const fetchCalls: Array<Request> = []
		const { kody, tokenRefreshCalls } = createKody(spotifyIntegration, {
			ok: true,
			refreshed: false,
			skippedReason: 'refresh_not_applicable',
			refreshedAt: null,
			refreshTokenRotated: false,
		})
		{
			using _fetchMock = createFetchMock({
				fetchCalls,
				apiErrors: [],
				apiResponses: [{ status: 401, body: { error: 'bad_credentials' } }],
			})
			const authenticatedFetch = await create(kody)
			const response = await authenticatedFetch('/me')
			expect({ label, status: response.status }).toEqual({
				label,
				status: 401,
			})
			expect(await response.json()).toEqual({ error: 'bad_credentials' })
		}
		expect({ label, tokenRefreshCalls, requests: fetchCalls.length }).toEqual({
			label,
			tokenRefreshCalls: [{ name: 'spotify' }],
			requests: 1,
		})
	}
})

test('createAuthenticatedFetch refreshes Slack on auth failures and HTML login, not on other ok:false', async () => {
	const scenarios = [
		{
			label: 'slack auth error',
			integration: slackIntegration,
			path: '/auth.test',
			apiResponses: [
				{ status: 200, body: { ok: false, error: 'token_revoked' } },
				{ status: 200, body: { ok: true } },
			] satisfies Array<ApiResponseSpec>,
			body: { ok: true },
			refreshCalls: [{ name: 'slack' }],
			requestCount: 2,
		},
		{
			label: 'slack HTML login',
			integration: slackIntegration,
			path: 'https://files.slack.com/files-pri/T000/F000/image.png',
			apiResponses: [
				{
					status: 200,
					body: '<html><body>Sign in to Slack</body></html>',
					contentType: 'text/html; charset=utf-8',
					url: 'https://files.slack.com/files-pri/T000/F000/image.png',
				},
				{ status: 200, body: { ok: true }, contentType: 'application/json' },
			] satisfies Array<ApiResponseSpec>,
			body: { ok: true },
			refreshCalls: [{ name: 'slack' }],
			requestCount: 2,
		},
		{
			label: 'slack non-auth error',
			integration: slackIntegration,
			path: '/conversations.info',
			apiResponses: [
				{ status: 200, body: { ok: false, error: 'channel_not_found' } },
			] satisfies Array<ApiResponseSpec>,
			body: { ok: false, error: 'channel_not_found' },
			refreshCalls: [],
			requestCount: 1,
		},
		{
			label: 'non-Slack auth-shaped error',
			integration: spotifyIntegration,
			path: '/me',
			apiResponses: [
				{ status: 200, body: { ok: false, error: 'token_revoked' } },
			] satisfies Array<ApiResponseSpec>,
			body: { ok: false, error: 'token_revoked' },
			refreshCalls: [],
			requestCount: 1,
		},
	]
	for (const scenario of scenarios) {
		const { kody, tokenRefreshCalls } = createKody(scenario.integration)
		const implementations = authenticatedFetchImplementations(
			scenario.integration,
			kody,
		)
		for (const [impl, create] of Object.entries(implementations)) {
			tokenRefreshCalls.length = 0
			const fetchCalls: Array<RecordedRequest> = []
			{
				using _fetchMock = createFetchMock({
					fetchCalls,
					apiErrors: [],
					apiResponses: scenario.apiResponses,
				})
				const authenticatedFetch = await create()
				const response = await authenticatedFetch(scenario.path)
				expect({
					label: `${scenario.label}:${impl}`,
					body: await response.json(),
				}).toEqual({
					label: `${scenario.label}:${impl}`,
					body: scenario.body,
				})
			}
			expect({
				label: `${scenario.label}:${impl}`,
				tokenRefreshCalls,
				requestCount: fetchCalls.length,
			}).toEqual({
				label: `${scenario.label}:${impl}`,
				tokenRefreshCalls: scenario.refreshCalls,
				requestCount: scenario.requestCount,
			})
		}
	}
})

test('createExecuteHelperPrelude exposes sandbox oauth and secret helper bindings', async () => {
	const helpers = createSandboxHelpers(
		dispatchFor(createKody(spotifyIntegration).kody),
	)
	expect(
		helpers.secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
	// packageSecrets.get(...) opaque refs pass straight into secretHeaders.basic
	// without package code parsing the placeholder.
	expect(
		helpers.secretHeaders.basic({
			usernameSecret: '{{secret:paypalClientId|scope=user}}',
			passwordSecret: '{{secret:paypalClientSecret|scope=user}}',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)

	const platform = createKody(githubPlatformIntegration)
	const platformCalls: Array<string> = []
	const platformHelpers = createSandboxHelpers(async (name, args) => {
		platformCalls.push(name)
		return await dispatchFor(platform.kody)(name, args)
	})
	expect(typeof platformHelpers.createAuthenticatedFetch).toBe('function')
	await platformHelpers.createAuthenticatedFetch('github')
	expect(platformCalls).toEqual(['integrationGet'])

	const clientCredentialsCalls: Array<RecordedRequest> = []
	{
		using _server = createMswNodeServer([
			http.post(
				'https://api-m.paypal.com/v1/oauth2/token',
				async ({ request }) => {
					clientCredentialsCalls.push(request.clone())
					return HttpResponse.json({
						access_token: 'paypal-access-token',
						token_type: 'Bearer',
					})
				},
			),
		])
		const tokenResponse = await helpers.oauthClientCredentials({
			tokenUrl: 'https://api-m.paypal.com/v1/oauth2/token',
			clientIdSecret: 'paypalClientId',
			clientSecretSecret: 'paypalClientSecret',
			scope: 'user',
			body: {
				scope: 'openid',
			},
		})
		expect(tokenResponse).toEqual({
			access_token: 'paypal-access-token',
			token_type: 'Bearer',
		})
	}
	expect(clientCredentialsCalls).toHaveLength(1)
	expect(clientCredentialsCalls[0]?.headers.get('authorization')).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
})

test('oauthClientCredentials passes the minted access token to trackAccessToken and returns the payload unchanged', async () => {
	const tracked: Array<string> = []
	const authorizations: Array<string | null> = []
	const payload = await oauthClientCredentials(
		{
			tokenUrl: 'https://oauth.example.com/token',
			clientIdSecret: 'exampleClientId',
			clientSecretSecret: 'exampleClientSecret',
		},
		{
			fetch: async (input, init) => {
				authorizations.push(
					new Request(input, init).headers.get('authorization'),
				)
				return Response.json({ access_token: 'minted-token', expires_in: 60 })
			},
			trackAccessToken: (accessToken) => tracked.push(accessToken),
		},
	)
	expect(payload).toEqual({ access_token: 'minted-token', expires_in: 60 })
	expect(tracked).toEqual(['minted-token'])
	expect(authorizations).toEqual([
		'{{secret-basic:username=exampleClientId,password=exampleClientSecret}}',
	])
})

test('sandbox oauthClientCredentials registers the access token and still returns it when tracking is unavailable', async () => {
	const calls: Array<{ name: string; args: CapabilityArgs }> = []
	using _server = createMswNodeServer([
		http.post('https://oauth.example.com/token', () =>
			HttpResponse.json({
				access_token: 'sandbox-token',
				token_type: 'Bearer',
			}),
		),
	])
	const input = {
		tokenUrl: 'https://oauth.example.com/token',
		clientIdSecret: 'exampleClientId',
		clientSecretSecret: 'exampleClientSecret',
	}
	const tracking = createSandboxHelpers(async (name, args) => {
		calls.push({ name, args })
		return { ok: true }
	})
	await expect(tracking.oauthClientCredentials(input)).resolves.toEqual({
		access_token: 'sandbox-token',
		token_type: 'Bearer',
	})
	expect(calls).toEqual([
		{ name: '__kodyTrackRunSecret', args: { value: 'sandbox-token' } },
	])
	const untracked = createSandboxHelpers(async (name) => {
		throw new Error(`${name} is not available in this sandbox.`)
	})
	await expect(untracked.oauthClientCredentials(input)).resolves.toEqual({
		access_token: 'sandbox-token',
		token_type: 'Bearer',
	})
})
