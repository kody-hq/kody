import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	credentialsFromTokens,
	isAccessTokenExpired,
	login,
} from '../src/auth.js'
import { CredentialDirError } from '../src/credential-dir.js'
import { buildCliAuthorizationUrl } from '../src/oauth-browser.js'
import {
	issuerFromStoredCredentials,
	orgSlugFromFlag,
} from '../src/oauth-provider.js'
import {
	createFileBackend,
	loadCredentials,
	parseCredentials,
	saveCredentials,
	type StoredCredentials,
} from '../src/store.js'

const previous: StoredCredentials = {
	version: 1,
	mcpUrl: 'https://kody.codes/mcp',
	resource: 'https://kody.codes/mcp',
	authorizationServerUrl: 'https://kody.codes',
	clientId: 'client-1',
	accessToken: 'old-access',
	refreshToken: 'old-refresh',
	tokenType: 'bearer',
	expiresAt: 1,
	scope: 'profile email',
}

function captureWarns(): { warnings: string[]; restore: () => void } {
	const warnings: string[] = []
	const original = console.warn
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(' '))
	}
	return {
		warnings,
		restore() {
			console.warn = original
		},
	}
}

test('isAccessTokenExpired uses a one-minute skew', () => {
	const now = 1_000_000
	assert.equal(
		isAccessTokenExpired({ ...previous, expiresAt: now + 30_000 }, now),
		true,
	)
	assert.equal(
		isAccessTokenExpired({ ...previous, expiresAt: now + 120_000 }, now),
		false,
	)
	assert.equal(
		isAccessTokenExpired({ ...previous, expiresAt: undefined }, now),
		false,
	)
})

test('credentialsFromTokens keeps the previous refresh token when omitted', () => {
	const next = credentialsFromTokens({
		mcpUrl: previous.mcpUrl,
		resource: previous.resource,
		authorizationServerUrl: previous.authorizationServerUrl,
		client: { client_id: 'client-1' },
		tokens: {
			access_token: 'new-access',
			token_type: 'bearer',
			expires_in: 3600,
		},
		previous,
		now: 5_000,
	})
	assert.equal(next.accessToken, 'new-access')
	assert.equal(next.refreshToken, 'old-refresh')
	assert.equal(next.expiresAt, 5_000 + 3600 * 1000)
})

test('credentialsFromTokens stores a rotated refresh token', () => {
	const next = credentialsFromTokens({
		mcpUrl: previous.mcpUrl,
		resource: previous.resource,
		authorizationServerUrl: previous.authorizationServerUrl,
		client: { client_id: 'client-1', client_secret: 'secret' },
		tokens: {
			access_token: 'new-access',
			refresh_token: 'rotated',
			token_type: 'bearer',
			expires_in: 10,
		},
		previous,
		now: 0,
	})
	assert.equal(next.refreshToken, 'rotated')
	assert.equal(next.clientSecret, 'secret')
	assert.equal(next.expiresAt, 10_000)
})

test('orgSlugFromFlag lowercases and rejects a blank slug', () => {
	assert.equal(orgSlugFromFlag('Acme'), 'acme')
	assert.equal(orgSlugFromFlag('  KentCDodds  '), 'kentcdodds')
	assert.throws(() => orgSlugFromFlag('   '), /kody login --org acme/)
})

test('authorize URL gets ?org= and keeps the canonical resource', async () => {
	const url = await buildCliAuthorizationUrl({
		authorizationServer: {
			issuer: 'https://kody.codes',
			authorization_endpoint: 'https://kody.codes/oauth/authorize',
		},
		mcpUrl: 'https://kody.codes/mcp',
		state: 'state',
		codeChallenge: 'challenge',
		org: 'Acme',
	})
	assert.equal(url.origin + url.pathname, 'https://kody.codes/oauth/authorize')
	assert.equal(url.searchParams.get('org'), 'acme')
	assert.equal(url.searchParams.get('resource'), 'https://kody.codes/mcp')
	assert.equal(url.searchParams.get('code_challenge'), 'challenge')
	assert.equal(new URL(url.searchParams.get('resource') ?? '').search, '')
})

function oauthDiscoveryFetch(origin: string): typeof fetch {
	const metadata = {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none'],
		client_id_metadata_document_supported: true,
	}
	const resource = {
		resource: `${origin}/mcp`,
		authorization_servers: [origin],
		scopes_supported: ['openid', 'profile', 'email'],
		bearer_methods_supported: ['header'],
	}
	return async (input) => {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url,
		)
		if (url.pathname.includes('oauth-protected-resource')) {
			return Response.json(resource)
		}
		if (
			url.pathname.includes('oauth-authorization-server') ||
			url.pathname.includes('openid-configuration')
		) {
			return Response.json(metadata)
		}
		return new Response('not found', { status: 404 })
	}
}

test('login appends ?org= on the authorize URL and omits it otherwise', async () => {
	const origin = 'https://oauth.test'
	const fetchFn = oauthDiscoveryFetch(origin)
	const withOrg: Array<URL> = []
	await assert.rejects(
		() =>
			login({
				mcpUrl: `${origin}/mcp`,
				org: 'Acme',
				openBrowser: false,
				timeoutMs: 200,
				fetchFn,
				onAuthorizationUrl: (url) => {
					withOrg.push(new URL(url.href))
				},
			}),
		/Timed out waiting for the browser login/,
	)
	assert.equal(withOrg.length, 1)
	const url = withOrg[0]
	assert.ok(url)
	assert.equal(url.origin + url.pathname, `${origin}/oauth/authorize`)
	assert.equal(url.searchParams.get('org'), 'acme')
	assert.equal(url.searchParams.get('resource'), `${origin}/mcp`)

	const withoutOrg: Array<URL> = []
	await assert.rejects(
		() =>
			login({
				mcpUrl: `${origin}/mcp`,
				openBrowser: false,
				timeoutMs: 200,
				fetchFn,
				onAuthorizationUrl: (url) => {
					withoutOrg.push(new URL(url.href))
				},
			}),
		/Timed out waiting for the browser login/,
	)
	assert.equal(withoutOrg.length, 1)
	assert.equal(withoutOrg[0]?.searchParams.get('org'), null)
	assert.equal(withoutOrg[0]?.searchParams.get('resource'), `${origin}/mcp`)
})

test('fresh login does not warn about a missing SEP-2352 issuer stamp', async () => {
	const origin = 'https://oauth.test'
	const fetchFn = oauthDiscoveryFetch(origin)
	const { warnings, restore } = captureWarns()
	try {
		await assert.rejects(
			() =>
				login({
					mcpUrl: `${origin}/mcp`,
					openBrowser: false,
					timeoutMs: 200,
					fetchFn,
				}),
			/Timed out waiting for the browser login/,
		)
	} finally {
		restore()
	}
	assert.equal(
		warnings.some((line) => line.includes('SEP-2352')),
		false,
		`unexpected SEP-2352 warnings: ${warnings.join('\n')}`,
	)
})

test('issuerFromStoredCredentials falls back to the MCP origin', () => {
	assert.equal(
		issuerFromStoredCredentials({
			...previous,
			authorizationServerUrl: '',
		}),
		'https://kody.codes',
	)
	assert.equal(issuerFromStoredCredentials(previous), 'https://kody.codes')
})

test('parseCredentials migrates a missing authorizationServerUrl from mcpUrl', () => {
	const migrated = parseCredentials(
		JSON.stringify({
			version: 1,
			mcpUrl: 'https://kody.codes/mcp',
			resource: 'https://kody.codes/mcp',
			clientId: 'client-1',
			accessToken: 'access-1',
			tokenType: 'bearer',
		}),
	)
	assert.equal(migrated.authorizationServerUrl, 'https://kody.codes')
})

test('save/load round-trip keeps authorizationServerUrl for issuer reload', async () => {
	const path = join(
		mkdtempSync(join(tmpdir(), 'kody-cli-')),
		'credentials.json',
	)
	const backend = createFileBackend(path)
	const credentials: StoredCredentials = {
		...previous,
		authorizationServerUrl: 'https://kody.codes',
		accessToken: 'round-trip-access',
	}
	saveCredentials(credentials, backend)
	const loaded = loadCredentials(credentials.mcpUrl, backend)
	assert.equal(loaded?.authorizationServerUrl, 'https://kody.codes')
	assert.equal(
		loaded ? issuerFromStoredCredentials(loaded) : '',
		'https://kody.codes',
	)
})

test('login stops before the browser when the credential folder is blocked', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kody-cli-blocked-'))
	const blocker = join(root, 'Application Support')
	writeFileSync(blocker, 'not a folder')
	const blockedDir = join(blocker, 'kody')
	const opened: Array<string> = []
	const urls: Array<URL> = []
	let fetched = false
	await assert.rejects(
		() =>
			login({
				mcpUrl: 'https://oauth.test/mcp',
				timeoutMs: 200,
				platform: 'darwin',
				resolution: {
					fileStorePath: () => join(blockedDir, 'credentials.json'),
				},
				fetchFn: async () => {
					fetched = true
					return new Response('unexpected', { status: 500 })
				},
				openUrlFn: async (url) => {
					opened.push(url)
					return true
				},
				onAuthorizationUrl: (url) => urls.push(url),
			}),
		(error: unknown) => {
			assert.ok(error instanceof CredentialDirError)
			assert.ok(error.message.includes(blockedDir))
			assert.match(error.message, /chown/)
			return true
		},
	)
	assert.deepEqual(opened, [])
	assert.deepEqual(urls, [])
	assert.equal(fetched, false)
})

test('login reports the URL even when the browser opener says it worked, and flags a failed open', async () => {
	const origin = 'https://oauth.test'
	const fetchFn = oauthDiscoveryFetch(origin)
	const dir = mkdtempSync(join(tmpdir(), 'kody-cli-open-'))
	for (const openerResult of [true, false]) {
		const events: Array<string> = []
		await assert.rejects(
			() =>
				login({
					mcpUrl: `${origin}/mcp`,
					timeoutMs: 200,
					fetchFn,
					resolution: { fileStorePath: () => join(dir, 'credentials.json') },
					onAuthorizationUrl: (url) => events.push(`url:${url.origin}`),
					openUrlFn: async () => {
						events.push('open')
						return openerResult
					},
					onBrowserOpenResult: ({ opened }) => events.push(`opened:${opened}`),
				}),
			/Timed out waiting for the browser login/,
		)
		assert.deepEqual(events, [
			`url:${origin}`,
			'open',
			`opened:${openerResult}`,
		])
	}
})

function signInFetch(origin: string, apiOrigin: string): typeof fetch {
	const discovery = oauthDiscoveryFetch(origin)
	return async (input, init) => {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url,
		)
		if (url.origin === origin && url.pathname === '/oauth/token') {
			return Response.json({
				access_token: 'oauth-access',
				token_type: 'bearer',
				expires_in: 3600,
			})
		}
		if (
			url.origin === apiOrigin &&
			url.pathname.endsWith('/v1/tokens/device')
		) {
			return Response.json({
				token: 'kody_at_test_device',
				scopes: ['execute'],
				login_org: { slug: 'acme' },
			})
		}
		return discovery(input, init)
	}
}

test('login shows the real folder error and the fix when saving fails after sign-in', async () => {
	const origin = 'https://oauth.test'
	const apiOrigin = 'https://api.kody.codes'
	const dir = mkdtempSync(join(tmpdir(), 'kody-cli-save-'))
	const path = join(dir, 'credentials.json')
	const backend = createFileBackend(path)
	backend.set = () => {
		throw Object.assign(
			new Error(`EACCES: permission denied, open '${path}'`),
			{ code: 'EACCES' },
		)
	}
	let callbackHtml = ''
	await assert.rejects(
		() =>
			login({
				mcpUrl: `${origin}/mcp`,
				apiUrl: apiOrigin,
				backend,
				platform: 'darwin',
				timeoutMs: 5_000,
				fetchFn: signInFetch(origin, apiOrigin),
				discoverIdentity: async () => ({
					org: 'acme',
					account: { email: 'person@example.com' },
				}),
				openUrlFn: async (href) => {
					const authorize = new URL(href)
					const callback = new URL(
						authorize.searchParams.get('redirect_uri') ?? '',
					)
					callback.searchParams.set('code', 'auth-code')
					callback.searchParams.set(
						'state',
						authorize.searchParams.get('state') ?? '',
					)
					void fetch(callback).then(async (response) => {
						callbackHtml = await response.text()
					})
					return true
				},
			}),
		(error: unknown) => {
			assert.ok(error instanceof CredentialDirError)
			assert.match(error.message, /You approved the sign-in/)
			assert.ok(error.message.includes(dir))
			assert.match(error.message, /EACCES: permission denied/)
			assert.match(error.message, /chown/)
			assert.doesNotMatch(error.message, /kody_at_test_device/)
			return true
		},
	)
	for (let i = 0; i < 50 && !callbackHtml; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	assert.match(callbackHtml, /data-error="save_failed"/)
})
