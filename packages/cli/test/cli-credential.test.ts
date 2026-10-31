import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { insufficientScopeMessage } from '../src/api-token.js'
import {
	deleteStoredApiToken,
	saveStoredApiToken,
	type StoredApiToken,
} from '../src/api-token-store.js'
import { runCli, storedApiTokenAfterLoginNotice } from '../src/cli.js'
import {
	resolveCliCredential,
	type CliCredentialSource,
} from '../src/cli-credential.js'
import { clearOpenApiRouteCache } from '../src/open-api-client.js'
import {
	createFileBackend,
	deleteCredentials,
	fileStorePath,
	saveCredentials,
	type StoredCredentials,
} from '../src/store.js'

// Test-only hosts so stored entries never touch a real kody.codes keyring item.
const apiUrl = 'https://api.cli-credential.test'
const mcpUrl = 'https://cli-credential.test/mcp'

const stored: StoredApiToken = {
	version: 1,
	apiUrl,
	token: 'kody_at_stored_old',
	tokenId: 'tok_stored_old',
	scopes: ['account:read', 'org:execute'],
	createdVia: 'cli-bootstrap',
}

const login: StoredCredentials = {
	version: 1,
	mcpUrl,
	resource: mcpUrl,
	authorizationServerUrl: 'https://cli-credential.test',
	clientId: 'client-1',
	accessToken: 'login-access',
	tokenType: 'bearer',
	expiresAt: Date.now() + 600_000,
	scope: 'account:read org:execute secret:create',
}

function pick(input: {
	flag?: string
	env?: string
	stored?: boolean
	login?: boolean
	purpose?: 'call' | 'session' | 'mint'
}) {
	const credential = resolveCliCredential({
		tokenValues: input.flag ? { token: input.flag } : {},
		env: input.env ? { KODY_API_TOKEN: input.env } : {},
		apiUrl,
		mcpUrl,
		...(input.purpose ? { purpose: input.purpose } : {}),
		loadApiToken: () => (input.stored ? stored : null),
		loadLogin: () => (input.login ? login : null),
	})
	return {
		source: credential?.source ?? null,
		shadowed: credential?.shadowed.map((other) => other.source) ?? [],
	}
}

test('resolveCliCredential call precedence: flag, env, stored token, login', () => {
	const all = {
		flag: 'kody_at_flag',
		env: 'kody_at_env',
		stored: true,
		login: true,
	}
	assert.deepEqual(pick(all), {
		source: 'token-flag',
		shadowed: ['env', 'stored-api-token', 'login'],
	})
	assert.deepEqual(pick({ ...all, flag: undefined }).source, 'env')
	assert.deepEqual(pick({ stored: true, login: true }), {
		source: 'stored-api-token',
		shadowed: ['login'],
	})
	assert.deepEqual(pick({ login: true }), { source: 'login', shadowed: [] })
	assert.deepEqual(pick({}), { source: null, shadowed: [] })
})

test('resolveCliCredential session precedence keeps login ahead of env and stored tokens', () => {
	const expect = (
		input: Parameters<typeof pick>[0],
		source: CliCredentialSource | null,
	) => assert.equal(pick({ ...input, purpose: 'session' }).source, source)
	expect({ flag: 'kody_at_flag', login: true }, 'token-flag')
	expect({ env: 'kody_at_env', stored: true, login: true }, 'login')
	expect({ env: 'kody_at_env', stored: true }, 'env')
	expect({ stored: true }, 'stored-api-token')
})

test('resolveCliCredential ignores an unreadable store that would not be used', () => {
	const credential = resolveCliCredential({
		tokenValues: { token: 'kody_at_flag' },
		env: {},
		apiUrl,
		mcpUrl,
		loadApiToken: () => {
			throw new Error('keyring locked')
		},
		loadLogin: () => login,
	})
	assert.equal(credential?.source, 'token-flag')
	assert.throws(
		() =>
			resolveCliCredential({
				env: {},
				apiUrl,
				mcpUrl,
				loadApiToken: () => {
					throw new Error('keyring locked')
				},
				loadLogin: () => login,
			}),
		/keyring locked/,
	)
})

test('insufficientScopeMessage names a stored token and says login does not replace it', () => {
	const credential = resolveCliCredential({
		env: {},
		apiUrl,
		mcpUrl,
		loadApiToken: () => stored,
		loadLogin: () => login,
	})
	const message = insufficientScopeMessage({
		requiredScope: 'secret:create',
		currentScopes: stored.scopes,
		credential,
	})
	assert.match(message, /Credential used: stored API token tok_stored_old/)
	assert.match(message, /`kody login` does not replace a stored API token/)
	assert.ok(
		message.includes(
			'npx @kodycodes/cli auth bootstrap --lifetime short --scopes account:read,org:execute,secret:create',
		),
		message,
	)
	assert.doesNotMatch(message, /kody_at_/)
	assert.doesNotMatch(message, /\u2014/)
})

test('insufficientScopeMessage for search with only a stored token suggests kody login', () => {
	const message = insufficientScopeMessage({
		requiredScope: 'search:read',
		currentScopes: stored.scopes,
		credential: resolveCliCredential({
			env: {},
			apiUrl,
			mcpUrl,
			purpose: 'session',
			loadApiToken: () => stored,
			loadLogin: () => null,
		}),
	})
	assert.match(message, /Credential used: stored API token tok_stored_old/)
	assert.match(message, /Run `kody login` \(search and cloud execute/)
	assert.doesNotMatch(message, /does not replace/)
})

test('insufficientScopeMessage names KODY_API_TOKEN and the login session', () => {
	const env = insufficientScopeMessage({
		requiredScope: 'secret:create',
		credential: resolveCliCredential({
			env: { KODY_API_TOKEN: 'kody_at_env' },
			apiUrl,
			mcpUrl,
			loadApiToken: () => stored,
			loadLogin: () => login,
		}),
	})
	assert.match(env, /Credential used: KODY_API_TOKEN/)
	const viaLogin = insufficientScopeMessage({
		requiredScope: 'secret:create',
		credential: resolveCliCredential({
			env: {},
			apiUrl,
			mcpUrl,
			loadApiToken: () => null,
			loadLogin: () => login,
		}),
	})
	assert.match(viaLogin, /Credential used: kody login session/)
	assert.equal(
		insufficientScopeMessage({
			denial: 'missing_permission',
			credential: null,
		}),
		insufficientScopeMessage({ denial: 'missing_permission' }),
	)
})

test('storedApiTokenAfterLoginNotice warns that login does not replace a stored token', () => {
	assert.equal(
		storedApiTokenAfterLoginNotice(apiUrl, () => null),
		'',
	)
	const notice = storedApiTokenAfterLoginNotice(apiUrl, () => stored)
	assert.match(notice, /does not replace it/)
	assert.match(
		notice,
		/auth bootstrap --lifetime short --scopes account:read,org:execute/,
	)
	assert.doesNotMatch(notice, /kody_at_/)
})

async function withStoredTokenAndLogin(
	run: (input: {
		authHeaders: Array<string>
		capture: (
			args: Array<string>,
		) => Promise<{ code: number; stdout: string; stderr: string }>
	}) => Promise<void>,
) {
	const home = mkdtempSync(join(tmpdir(), 'kody-cli-both-'))
	const saved = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		HOME: process.env.HOME,
		KODY_API_TOKEN: process.env.KODY_API_TOKEN,
		KODY_MCP_URL: process.env.KODY_MCP_URL,
		KODY_ORG: process.env.KODY_ORG,
	}
	process.env.XDG_CONFIG_HOME = home
	process.env.HOME = home
	delete process.env.KODY_API_TOKEN
	delete process.env.KODY_ORG
	process.env.KODY_MCP_URL = mcpUrl
	saveStoredApiToken(stored)
	saveCredentials(login, createFileBackend(fileStorePath(mcpUrl)))
	const authHeaders: Array<string> = []
	const previousFetch = globalThis.fetch
	clearOpenApiRouteCache()
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(String(input))
		authHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			})
		if (url.pathname === '/openapi.json') {
			return json({
				paths: { '/v1/secrets': { post: { operationId: 'secretSet' } } },
			})
		}
		if (url.pathname === '/v1/tokens/current') {
			return json({
				id: 'tok_stored_old',
				name: 'kody-cli-bootstrap',
				scopes: stored.scopes,
				expires_at: '2026-11-01T00:00:00.000Z',
			})
		}
		if (url.pathname === '/v1/me') {
			return json({
				user_id: 'user_1',
				email: 'a@example.com',
				display_name: 'A',
			})
		}
		if (url.pathname === '/v1/secrets') {
			return json(
				{
					error: {
						code: 'insufficient_scope',
						message: 'missing secret:create',
						details: { required_scope: 'secret:create' },
					},
				},
				403,
			)
		}
		return new Response('not found', { status: 404 })
	}) as typeof fetch
	try {
		await run({
			authHeaders,
			capture: async (args) => {
				let stdout = ''
				let stderr = ''
				const code = await runCli(args, {
					stdout: (text) => (stdout += text),
					stderr: (text) => (stderr += text),
				})
				return { code, stdout, stderr }
			},
		})
	} finally {
		globalThis.fetch = previousFetch
		clearOpenApiRouteCache()
		deleteStoredApiToken(apiUrl)
		deleteCredentials(mcpUrl)
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

test('with a stored token and a login, whoami reports the credential api sends', async () => {
	await withStoredTokenAndLogin(async ({ authHeaders, capture }) => {
		const whoami = await capture(['whoami', '--api-url', apiUrl])
		assert.equal(whoami.code, 0, whoami.stderr)
		assert.match(
			whoami.stdout,
			/credential: stored API token tok_stored_old \(from kody auth bootstrap\)/,
		)
		assert.match(whoami.stdout, /scopes: account:read, org:execute/)
		assert.match(whoami.stdout, /also stored: kody login session/)
		assert.match(
			whoami.stdout,
			/`kody login` does not replace a stored API token/,
		)
		assert.doesNotMatch(whoami.stdout, /kody_at_/)
		const whoamiBearers = new Set(authHeaders.splice(0))
		assert.deepEqual([...whoamiBearers], ['Bearer kody_at_stored_old'])

		const api = await capture([
			'api',
			'secretSet',
			'--params',
			'{"name":"x","value":"y"}',
			'--api-url',
			apiUrl,
		])
		assert.equal(api.code, 1)
		assert.ok(authHeaders.includes('Bearer kody_at_stored_old'))
		assert.match(api.stderr, /insufficient_scope/)
		assert.match(api.stderr, /Credential used: stored API token tok_stored_old/)
		assert.match(api.stderr, /`kody login` does not replace a stored API token/)
		assert.match(
			api.stderr,
			/npx @kodycodes\/cli auth bootstrap --lifetime short --scopes/,
		)
		assert.doesNotMatch(api.stderr, /kody_at_/)
	})
})

test('whoami --json reports credential provenance and the other stored credential', async () => {
	await withStoredTokenAndLogin(async ({ capture }) => {
		const result = await capture(['whoami', '--api-url', apiUrl, '--json'])
		assert.equal(result.code, 0, result.stderr)
		const body = JSON.parse(result.stdout) as {
			credential: { source: string; tokenId?: string }
			otherCredentials: Array<{ source: string }>
			searchAndCloudExecuteCredential?: { source: string }
		}
		assert.equal(body.credential.source, 'stored-api-token')
		assert.equal(body.credential.tokenId, 'tok_stored_old')
		assert.deepEqual(
			body.otherCredentials.map((other) => other.source),
			['login'],
		)
		assert.equal(body.searchAndCloudExecuteCredential?.source, 'login')
		assert.doesNotMatch(result.stdout, /kody_at_/)
	})
})

test('desktop login selection never reads or replaces stored API tokens and never falls back to them', () => {
	for (const available of [true, false]) {
		const result = resolveCliCredential({
			env: {
				KODY_CREDENTIAL_SOURCE: 'login',
				KODY_API_TOKEN: 'unrelated-token',
			},
			apiUrl,
			mcpUrl,
			org: 'jane',
			loadApiToken: () => {
				throw new Error('Must not read unrelated API tokens')
			},
			loadLogin: (_url, org) => {
				assert.equal(org, 'jane')
				return available ? login : null
			},
		})
		assert.equal(result?.source ?? null, available ? 'login' : null)
	}
	assert.throws(
		() => resolveCliCredential({ env: { KODY_CREDENTIAL_SOURCE: 'typo' } }),
		/must be login/,
	)
})
