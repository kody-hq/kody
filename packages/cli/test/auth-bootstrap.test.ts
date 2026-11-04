import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
	assertCliBootstrapCode,
	authBootstrap,
	cliTokenLifetimeAliases,
	cliTokenLifetimeMissingError,
	parseCliBootstrapCode,
	redeemBootstrapCode,
	resolveCliTokenLifetime,
} from '../src/auth-bootstrap.js'
import {
	deleteStoredApiToken,
	loadStoredApiToken,
	parseStoredApiToken,
	saveStoredApiToken,
	type StoredApiToken,
} from '../src/api-token-store.js'
import { resolveLocalExecuteBearer, runCli } from '../src/cli.js'
import { createFileBackend } from '../src/store.js'
import { redact } from '../src/redact.js'

/** Matches platform `kody_bc_<16>_<32 base64url>`. */
const goodCode = `kody_bc_${'a'.repeat(16)}_${'B'.repeat(32)}`
const goodToken = 'kody_at_test_secret_value_do_not_print'

type RedeemRequest = {
	method: string
	url: string
	authorization: string | null
	body: unknown
}

const requests: Array<RedeemRequest> = []
let redeemStatus = 200
let redeemBody: unknown = {
	token: goodToken,
	token_type: 'Bearer',
	id: 'tok_bootstrap_1',
	name: 'kody-cli-bootstrap',
	scopes: ['account:read', 'local-execute'],
	status: 'active',
	idle_ttl_seconds: 3600,
	expires_at: '2026-10-02T12:00:00.000Z',
	max_expires_at: '2026-10-08T12:00:00.000Z',
	created_via: 'cli-bootstrap',
}
let apiUrl = ''
let server: Server

before(async () => {
	server = createServer(async (request, response) => {
		let raw = ''
		for await (const chunk of request) raw += chunk
		const body = raw ? JSON.parse(raw) : null
		requests.push({
			method: request.method ?? '',
			url: request.url ?? '',
			authorization: request.headers.authorization ?? null,
			body,
		})
		response.writeHead(redeemStatus, { 'content-type': 'application/json' })
		response.end(JSON.stringify(redeemBody))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
	server.closeAllConnections()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

function reset() {
	requests.length = 0
	redeemStatus = 200
	redeemBody = {
		token: goodToken,
		token_type: 'Bearer',
		id: 'tok_bootstrap_1',
		name: 'kody-cli-bootstrap',
		scopes: ['account:read', 'local-execute'],
		status: 'active',
		idle_ttl_seconds: 3600,
		expires_at: '2026-10-02T12:00:00.000Z',
		max_expires_at: '2026-10-08T12:00:00.000Z',
		created_via: 'cli-bootstrap',
	}
}

function tempBackend() {
	const path = join(
		mkdtempSync(join(tmpdir(), 'kody-cli-boot-')),
		'api-token.json',
	)
	return createFileBackend(path)
}

test('parseCliBootstrapCode accepts platform-shaped codes', () => {
	assert.deepEqual(parseCliBootstrapCode(goodCode), {
		codeId: 'a'.repeat(16),
		secret: 'B'.repeat(32),
	})
	assert.equal(parseCliBootstrapCode('kody_at_not_a_bootstrap'), null)
	assert.throws(() => assertCliBootstrapCode('nope'), /cliCredentialBootstrap/)
})

test('resolveCliTokenLifetime requires a choice and expands short/long/explicit', () => {
	assert.throws(() => resolveCliTokenLifetime({}), /Token lifetime is required/)
	assert.throws(() => resolveCliTokenLifetime({}), /--lifetime short\|long/)
	assert.throws(
		() => resolveCliTokenLifetime({}),
		/Single-task agents should use --lifetime short/,
	)
	assert.equal(
		cliTokenLifetimeMissingError().includes('--lifetime short|long'),
		true,
	)
	assert.deepEqual(resolveCliTokenLifetime({ lifetime: 'short' }), {
		kind: 'alias',
		lifetime: 'short',
		idleTtlSeconds: cliTokenLifetimeAliases.short.idleTtlSeconds,
		maxLifetimeSeconds: cliTokenLifetimeAliases.short.maxLifetimeSeconds,
	})
	assert.deepEqual(resolveCliTokenLifetime({ lifetime: 'long' }), {
		kind: 'alias',
		lifetime: 'long',
		idleTtlSeconds: cliTokenLifetimeAliases.long.idleTtlSeconds,
		maxLifetimeSeconds: cliTokenLifetimeAliases.long.maxLifetimeSeconds,
	})
	assert.deepEqual(
		resolveCliTokenLifetime({ idleTtlSeconds: 120, maxLifetimeSeconds: 600 }),
		{ kind: 'explicit', idleTtlSeconds: 120, maxLifetimeSeconds: 600 },
	)
	assert.throws(
		() =>
			resolveCliTokenLifetime({
				lifetime: 'short',
				idleTtlSeconds: 120,
				maxLifetimeSeconds: 600,
			}),
		/not both forms/,
	)
})

test('redeemBootstrapCode POSTs JSON code with lifetime and no Authorization header', async () => {
	reset()
	const redeemed = await redeemBootstrapCode({
		code: goodCode,
		lifetime: 'short',
		apiUrl,
		fetchFn: fetch,
	})
	assert.equal(requests.length, 1)
	assert.equal(requests[0]?.method, 'POST')
	assert.equal(requests[0]?.url, '/v1/tokens/bootstrap/redeem')
	assert.equal(requests[0]?.authorization, null)
	assert.deepEqual(requests[0]?.body, { code: goodCode, lifetime: 'short' })
	assert.equal(redeemed.token, goodToken)
	assert.equal(redeemed.id, 'tok_bootstrap_1')
	assert.equal(redeemed.created_via, 'cli-bootstrap')
})

test('redeemBootstrapCode POSTs explicit idle/max seconds when aliases are omitted', async () => {
	reset()
	await redeemBootstrapCode({
		code: goodCode,
		idleTtlSeconds: 180,
		maxLifetimeSeconds: 900,
		apiUrl,
		fetchFn: fetch,
	})
	assert.deepEqual(requests[0]?.body, {
		code: goodCode,
		idle_ttl_seconds: 180,
		max_lifetime_seconds: 900,
	})
})

test('authBootstrap redeems and stores without exposing the token in returned metadata fields used for printing', async () => {
	reset()
	const backend = tempBackend()
	const result = await authBootstrap({
		code: goodCode,
		lifetime: 'short',
		apiUrl,
		backend,
		fetchFn: fetch,
	})
	assert.equal(result.backendKind, 'file')
	assert.equal(result.stored.tokenId, 'tok_bootstrap_1')
	assert.equal(result.stored.createdVia, 'cli-bootstrap')
	assert.deepEqual(result.stored.scopes, ['account:read', 'local-execute'])
	assert.deepEqual(requests[0]?.body, { code: goodCode, lifetime: 'short' })
	const loaded = loadStoredApiToken(apiUrl, backend)
	assert.equal(loaded?.token, goodToken)
	assert.equal(loaded?.tokenId, 'tok_bootstrap_1')
	assert.ok(backend.path)
	const onDisk = JSON.parse(
		readFileSync(backend.path, 'utf8'),
	) as StoredApiToken
	assert.equal(onDisk.token, goodToken)
	assert.equal(onDisk.version, 1)
	assert.equal('lifetime' in onDisk, false)
})

test('runCli auth bootstrap redeems and never prints the kody_at_ token', async () => {
	reset()
	const home = mkdtempSync(join(tmpdir(), 'kody-cli-home-'))
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousHome = process.env.HOME
	process.env.XDG_CONFIG_HOME = home
	process.env.HOME = home
	// Windows keeps CLI config under %APPDATA%, and the OS keyring is per user
	// (not per HOME), so clear any token an earlier test stored for apiUrl.
	const previousAppData = process.env.APPDATA
	process.env.APPDATA = home
	deleteStoredApiToken(apiUrl)
	let stdout = ''
	try {
		const code = await runCli(
			[
				'auth',
				'bootstrap',
				'--code',
				goodCode,
				'--lifetime',
				'short',
				'--api-url',
				apiUrl,
			],
			{
				stdout: (text) => {
					stdout += text
				},
			},
		)
		assert.equal(code, 0)
		assert.match(stdout, /Bootstrap API token stored/)
		assert.match(stdout, /tok_bootstrap_1/)
		assert.match(stdout, /local-execute/)
		assert.doesNotMatch(stdout, /kody_at_/)
		assert.doesNotMatch(
			stdout,
			new RegExp(goodToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		)
		assert.equal(requests[0]?.authorization, null)
		assert.deepEqual(requests[0]?.body, { code: goodCode, lifetime: 'short' })
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
		if (previousAppData === undefined) delete process.env.APPDATA
		else process.env.APPDATA = previousAppData
		deleteStoredApiToken(apiUrl)
	}
})

test('runCli auth bootstrap fails clearly when lifetime is missing', async () => {
	reset()
	let stderr = ''
	const code = await runCli(
		['auth', 'bootstrap', '--code', goodCode, '--api-url', apiUrl],
		{
			stderr: (text) => {
				stderr += text
			},
		},
	)
	assert.equal(code, 1)
	assert.match(stderr, /Token lifetime is required/)
	assert.match(stderr, /--lifetime short\|long/)
	assert.match(stderr, /--idle-ttl-seconds/)
	assert.match(stderr, /--max-lifetime-seconds/)
	assert.match(stderr, /Single-task agents should use --lifetime short/)
	assert.equal(requests.length, 0)
})

test('resolveLocalExecuteBearer prefers stored bootstrap token over login OAuth', async () => {
	const backend = tempBackend()
	saveStoredApiToken(
		{
			version: 1,
			apiUrl: 'https://api.kody.codes',
			token: 'kody_at_stored_bootstrap',
			tokenId: 'tok_stored',
			scopes: ['local-execute'],
			createdVia: 'cli-bootstrap',
		},
		backend,
	)
	const token = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		apiUrl: 'https://api.kody.codes',
		apiTokenBackend: backend,
		ensureCredentials: async () => {
			throw new Error(
				'login should not be consulted when bootstrap token is stored',
			)
		},
	})
	assert.equal(token, 'kody_at_stored_bootstrap')
})

test('resolveLocalExecuteBearer still prefers --token over stored bootstrap', async () => {
	const backend = tempBackend()
	saveStoredApiToken(
		{
			version: 1,
			apiUrl: 'https://api.kody.codes',
			token: 'kody_at_stored_bootstrap',
			tokenId: 'tok_stored',
		},
		backend,
	)
	const token = await resolveLocalExecuteBearer({
		tokenValues: { token: 'kody_at_flag' },
		env: {},
		apiUrl: 'https://api.kody.codes',
		apiTokenBackend: backend,
		ensureCredentials: async () => {
			throw new Error('login should not run')
		},
	})
	assert.equal(token, 'kody_at_flag')
})

test('whoami uses stored bootstrap token without env, --token, or login', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-cli-whoami-store-'))
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousHome = process.env.HOME
	const previousToken = process.env.KODY_API_TOKEN
	const previousMcpUrl = process.env.KODY_MCP_URL
	process.env.XDG_CONFIG_HOME = home
	process.env.HOME = home
	// Windows keeps CLI config under %APPDATA%, and the OS keyring is per user
	// (not per HOME), so clear any token an earlier test stored for apiUrl.
	const previousAppData = process.env.APPDATA
	process.env.APPDATA = home
	deleteStoredApiToken(apiUrl)
	delete process.env.KODY_API_TOKEN
	process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
	const storedToken = 'kody_at_whoami_stored'
	saveStoredApiToken({
		version: 1,
		apiUrl,
		token: storedToken,
		tokenId: 'tok_whoami_stored',
		scopes: ['account:read', 'local-execute'],
		createdVia: 'cli-bootstrap',
		expiresAt: '2026-10-02T12:00:00.000Z',
	})
	const authHeaders: Array<string | null> = []
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input)
		const headers = new Headers(init?.headers)
		authHeaders.push(headers.get('authorization'))
		if (url.includes('/v1/tokens/current')) {
			return new Response(
				JSON.stringify({
					id: 'tok_whoami_stored',
					name: 'kody-cli-bootstrap',
					scopes: ['account:read', 'local-execute'],
					expires_at: '2026-10-02T12:00:00.000Z',
					max_expires_at: null,
				}),
				{ status: 200 },
			)
		}
		if (url.includes('/v1/me')) {
			return new Response(
				JSON.stringify({
					user_id: 'user_1',
					email: 'agent@example.com',
					display_name: 'Agent',
				}),
				{ status: 200 },
			)
		}
		return new Response('not found', { status: 404 })
	}) as typeof fetch
	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(['whoami', '--api-url', apiUrl], {
			stdout: (text) => {
				stdout += text
			},
			stderr: (text) => {
				stderr += text
			},
		})
		assert.equal(code, 0, stderr)
	} finally {
		globalThis.fetch = previousFetch
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
		if (previousAppData === undefined) delete process.env.APPDATA
		else process.env.APPDATA = previousAppData
		deleteStoredApiToken(apiUrl)
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.match(stdout, /tok_whoami_stored/)
	assert.match(stdout, /Agent <agent@example.com>/)
	assert.doesNotMatch(stdout, /kody_at_/)
	assert.doesNotMatch(stderr, /Not logged in/)
	assert.ok(authHeaders.some((header) => header === `Bearer ${storedToken}`))
})

test('search uses stored bootstrap token without env, --token, or login', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-cli-search-store-'))
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousHome = process.env.HOME
	const previousToken = process.env.KODY_API_TOKEN
	const previousMcpUrl = process.env.KODY_MCP_URL
	process.env.XDG_CONFIG_HOME = home
	process.env.HOME = home
	// Windows keeps CLI config under %APPDATA%, and the OS keyring is per user
	// (not per HOME), so clear any token an earlier test stored for apiUrl.
	const previousAppData = process.env.APPDATA
	process.env.APPDATA = home
	deleteStoredApiToken(apiUrl)
	delete process.env.KODY_API_TOKEN
	process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
	const storedToken = 'kody_at_search_stored'
	saveStoredApiToken({
		version: 1,
		apiUrl,
		token: storedToken,
		tokenId: 'tok_search_stored',
		scopes: ['local-execute'],
		createdVia: 'cli-bootstrap',
	})
	const authHeaders: Array<string | null> = []
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input)
		const headers = new Headers(init?.headers)
		authHeaders.push(headers.get('authorization'))
		if (url.includes('/v1/search')) {
			return new Response(
				JSON.stringify({
					results: [{ id: 'guide:open_api', title: 'Open API' }],
				}),
				{ status: 200 },
			)
		}
		return new Response('not found', { status: 404 })
	}) as typeof fetch
	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(['search', 'open api', '--api-url', apiUrl], {
			stdout: (text) => {
				stdout += text
			},
			stderr: (text) => {
				stderr += text
			},
		})
		assert.equal(code, 0, stderr)
	} finally {
		globalThis.fetch = previousFetch
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
		if (previousAppData === undefined) delete process.env.APPDATA
		else process.env.APPDATA = previousAppData
		deleteStoredApiToken(apiUrl)
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.match(stdout, /guide:open_api/)
	assert.doesNotMatch(stdout, /kody_at_/)
	assert.doesNotMatch(stderr, /Not logged in/)
	assert.ok(authHeaders.some((header) => header === `Bearer ${storedToken}`))
})

test('parseStoredApiToken rejects non-kody_at payloads', () => {
	assert.throws(
		() =>
			parseStoredApiToken(
				JSON.stringify({
					version: 1,
					apiUrl: 'https://api.kody.codes',
					token: 'oauth-looking',
					tokenId: 'x',
				}),
			),
		/invalid/i,
	)
})

test('redact strips kody_at_ and kody_bc_ secrets from messages', () => {
	assert.match(redact(`got ${goodToken} and ${goodCode}`), /kody_\[redacted]/)
	assert.doesNotMatch(redact(`got ${goodToken}`), /kody_at_test/)
})

test('redeemBootstrapCode surfaces already-used codes clearly', async () => {
	reset()
	redeemStatus = 400
	redeemBody = {
		error: { code: 'invalid_request', message: 'already redeemed' },
	}
	await assert.rejects(
		() =>
			redeemBootstrapCode({
				code: goodCode,
				lifetime: 'short',
				apiUrl,
				fetchFn: fetch,
			}),
		/already used[\s\S]*Call cliCredentialBootstrap again for a fresh code/,
	)
})

test('redeemBootstrapCode rejects missing lifetime before calling the API', async () => {
	reset()
	await assert.rejects(
		() => redeemBootstrapCode({ code: goodCode, apiUrl, fetchFn: fetch }),
		/--lifetime short\|long/,
	)
	assert.equal(requests.length, 0)
})
