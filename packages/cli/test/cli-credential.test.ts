import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	insufficientScopeMessage,
	rejectedApiTokenMessage,
} from '../src/api-token.js'
import {
	deleteStoredApiToken,
	saveStoredApiToken,
	type StoredApiToken,
} from '../src/api-token-store.js'
import { runCli, supersedeStoredApiTokenAfterLogin } from '../src/cli.js'
import {
	credentialRejectedNote,
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

test('resolveCliCredential precedence: flag, env, then the saved credential', () => {
	const all = {
		flag: 'kody_at_flag',
		env: 'kody_at_env',
		stored: true,
		login: true,
	}
	assert.deepEqual(pick(all), {
		source: 'token-flag',
		shadowed: ['env', 'login'],
	})
	assert.deepEqual(pick({ ...all, flag: undefined }).source, 'env')
	// The saved credential wins; a leftover old-slot token is never a fallback.
	assert.deepEqual(pick({ stored: true, login: true }), {
		source: 'login',
		shadowed: [],
	})
	assert.deepEqual(pick({ login: true }), { source: 'login', shadowed: [] })
	assert.deepEqual(pick({}), { source: null, shadowed: [] })
})

test('resolveCliCredential uses the same order for every purpose', () => {
	for (const purpose of ['call', 'session', 'mint'] as const) {
		assert.equal(
			pick({ env: 'kody_at_env', login: true, purpose }).source,
			'env',
		)
		assert.equal(pick({ login: true, purpose }).source, 'login')
	}
})

test('resolveCliCredential adopts an old-slot token only when nothing is saved', () => {
	const saved: Array<StoredCredentials> = []
	const deleted: Array<string> = []
	const credential = resolveCliCredential({
		env: {},
		apiUrl,
		mcpUrl,
		loadApiToken: () => stored,
		loadLogin: () => null,
		saveLogin: (credentials) => {
			saved.push(credentials)
			return { backend: createFileBackend('/dev/null') }
		},
		deleteApiToken: (url) => {
			deleted.push(url ?? '')
			return { deleted: true, backend: createFileBackend('/dev/null') }
		},
	})
	assert.equal(credential?.source, 'login')
	assert.equal(credential?.login?.accessToken, stored.token)
	assert.equal(saved[0]?.accessToken, stored.token)
	assert.deepEqual(deleted, [apiUrl])
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
	assert.equal(
		resolveCliCredential({
			env: {},
			apiUrl,
			mcpUrl,
			loadApiToken: () => {
				throw new Error('keyring locked')
			},
			loadLogin: () => login,
		})?.source,
		'login',
	)
	assert.throws(
		() =>
			resolveCliCredential({
				env: {},
				apiUrl,
				mcpUrl,
				loadApiToken: () => {
					throw new Error('keyring locked')
				},
				loadLogin: () => null,
			}),
		/keyring locked/,
	)
})

test('insufficientScopeMessage names the saved credential and how to widen it', () => {
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
	assert.match(message, /Credential used: saved CLI credential/)
	assert.match(message, /Run `kody login`/)
	assert.match(message, /cliCredentialBootstrap with no scopes/)
	assert.doesNotMatch(message, /stored API token/)
	assert.doesNotMatch(message, /kody_at_/)
	assert.doesNotMatch(message, /\u2014/)
})

test('rejectedApiTokenMessage names the saved credential and the reauth path', () => {
	const credential = resolveCliCredential({
		env: {},
		apiUrl,
		mcpUrl,
		loadApiToken: () => stored,
		loadLogin: () => login,
	})
	const message = rejectedApiTokenMessage(
		' Server said: API token expired. Agents on MCP: call cliCredentialBootstrap…',
		credential,
	)
	assert.match(message, /Credential used: saved CLI credential/)
	assert.match(message, /Run `kody login`/)
	assert.match(message, /Server said: API token expired/)
	assert.doesNotMatch(message, /stored API token/)
	assert.doesNotMatch(message, /kody_at_/)
})

test('rejectedApiTokenMessage names KODY_API_TOKEN over the saved credential', () => {
	const env = rejectedApiTokenMessage(
		'',
		resolveCliCredential({
			env: { KODY_API_TOKEN: 'kody_at_env' },
			apiUrl,
			mcpUrl,
			loadApiToken: () => stored,
			loadLogin: () => login,
		}),
	)
	assert.match(env, /Credential used: KODY_API_TOKEN/)
	assert.match(env, /unset or replace KODY_API_TOKEN/)
	assert.match(env, /cli_command/)
	assert.equal(credentialRejectedNote({ credential: null }), null)
	assert.match(rejectedApiTokenMessage('', null), /cliCredentialBootstrap/)
})

test('insufficientScopeMessage names KODY_API_TOKEN over the saved credential', () => {
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
	assert.match(env, /wins over the saved CLI credential/)
})

test('kody login removes a leftover old-slot token and says so', () => {
	const deleted: Array<string> = []
	const deleteApiToken = (url?: string) => {
		deleted.push(url ?? '')
		return { deleted: true, backend: null as never }
	}
	assert.equal(
		supersedeStoredApiTokenAfterLogin(apiUrl, {
			env: {},
			loadApiToken: () => null,
			deleteApiToken,
		}),
		'',
	)
	assert.deepEqual(deleted, [])

	const notice = supersedeStoredApiTokenAfterLogin(apiUrl, {
		env: {},
		loadApiToken: () => stored,
		deleteApiToken,
	})
	assert.deepEqual(deleted, [apiUrl])
	assert.match(notice, /Removed the old stored API token tok_stored_old/)
	assert.match(notice, /every command, including git, uses this login/)
	assert.doesNotMatch(notice, /kody_at_/)
})

test('kody login keeps env precedence and desktop-only logins leave the old slot', () => {
	const deleted: Array<string> = []
	const deleteApiToken = (url?: string) => {
		deleted.push(url ?? '')
		return { deleted: true, backend: null as never }
	}
	const withEnv = supersedeStoredApiTokenAfterLogin(apiUrl, {
		env: { KODY_API_TOKEN: 'kody_at_env' },
		loadApiToken: () => stored,
		deleteApiToken,
	})
	assert.match(withEnv, /KODY_API_TOKEN is set .* still takes precedence/)
	assert.match(withEnv, /Removed the old stored/)
	assert.doesNotMatch(withEnv, /kody_at_env/)

	deleted.length = 0
	assert.equal(
		supersedeStoredApiTokenAfterLogin(apiUrl, {
			env: { KODY_CREDENTIAL_SOURCE: 'login' },
			loadApiToken: () => stored,
			deleteApiToken,
		}),
		'',
	)
	assert.deepEqual(deleted, [])

	const failed = supersedeStoredApiTokenAfterLogin(apiUrl, {
		env: {},
		loadApiToken: () => stored,
		deleteApiToken: () => ({ deleted: false, backend: null as never }),
	})
	assert.match(failed, /could not remove the old stored .*It is ignored/)
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
	saveCredentials(
		{ ...login, accessToken: 'kody_at_login' },
		createFileBackend(fileStorePath(mcpUrl)),
	)
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

test('with an old-slot token and a login, every command sends the login', async () => {
	await withStoredTokenAndLogin(async ({ authHeaders, capture }) => {
		const whoami = await capture(['whoami', '--api-url', apiUrl])
		assert.equal(whoami.code, 0, whoami.stderr)
		assert.match(whoami.stdout, /credential: saved CLI credential/)
		assert.doesNotMatch(whoami.stdout, /stored API token/)
		assert.doesNotMatch(whoami.stdout, /kody_at_/)
		assert.ok(!authHeaders.includes('Bearer kody_at_stored_old'))

		const api = await capture([
			'api',
			'secretSet',
			'--params',
			'{"name":"x","value":"y"}',
			'--api-url',
			apiUrl,
		])
		assert.ok(!authHeaders.includes('Bearer kody_at_stored_old'))
		assert.doesNotMatch(api.stderr, /kody_at_/)
	})
})

test('whoami --json reports the saved credential as the only source', async () => {
	await withStoredTokenAndLogin(async ({ capture }) => {
		const result = await capture(['whoami', '--api-url', apiUrl, '--json'])
		assert.equal(result.code, 0, result.stderr)
		const body = JSON.parse(result.stdout) as {
			credential: { source: string }
			otherCredentials: Array<{ source: string }>
		}
		assert.equal(body.credential.source, 'login')
		assert.deepEqual(body.otherCredentials, [])
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
