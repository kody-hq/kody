import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	cliBootstrapMintCall,
	cliBootstrapScopesCommand,
	inferCliTokenLifetimeAlias,
	insufficientScopeMessage,
	readInsufficientScopeDetails,
} from '../src/api-token.js'
import {
	deleteStoredApiToken,
	loadStoredApiToken,
} from '../src/api-token-store.js'
import {
	parseCliScopesFlag,
	resolveMintedRedeemLifetime,
} from '../src/auth-bootstrap.js'
import { openCapabilityProxySession } from '../src/capability-proxy.js'
import { runCli } from '../src/cli.js'
import {
	createFileBackend,
	fileStorePath,
	saveCredentials,
} from '../src/store.js'

const apiUrl = 'https://api.scopes.test'
const mintedCode = `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`
const redeemedToken = 'kody_at_scoped_secret_do_not_print'
const requestedScopes = ['org:execute', 'package:read', 'package:write']

type Recorded = { url: string; authorization: string | null; body: unknown }

const openApiDocument = {
	paths: {
		'/v1/tokens/bootstrap': { post: { operationId: 'cliCredentialBootstrap' } },
	},
}

function mintResponse(scopes: Array<string>) {
	return {
		bootstrap_code: mintedCode,
		expires_at: '2026-10-12T02:00:00.000Z',
		cli_command: `npx @kodycodes/cli auth bootstrap --code ${mintedCode} --lifetime short`,
		name: 'kody-cli-bootstrap',
		scopes,
		idle_ttl_seconds: 3600,
		max_lifetime_seconds: 86400,
	}
}

const redeemResponse = {
	token: redeemedToken,
	token_type: 'Bearer',
	id: 'tok_scoped_1',
	name: 'kody-cli-bootstrap',
	scopes: requestedScopes,
	status: 'active',
	idle_ttl_seconds: 3600,
	expires_at: '2026-10-12T03:00:00.000Z',
	max_expires_at: '2026-10-13T02:00:00.000Z',
	created_via: 'cli-bootstrap',
}

/** Isolate HOME/XDG/env, install a fetch stub, and restore everything after. */
async function withCliEnv<T>(
	fetchStub: (
		url: string,
		init: RequestInit | undefined,
	) => Promise<Response> | Response,
	run: (ctx: { home: string; requests: Array<Recorded> }) => Promise<T>,
): Promise<T> {
	const home = mkdtempSync(join(tmpdir(), 'kody-cli-scopes-'))
	const saved = {
		HOME: process.env.HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		APPDATA: process.env.APPDATA,
		KODY_API_TOKEN: process.env.KODY_API_TOKEN,
		KODY_MCP_URL: process.env.KODY_MCP_URL,
		KODY_API_URL: process.env.KODY_API_URL,
	}
	process.env.HOME = home
	process.env.XDG_CONFIG_HOME = home
	// Windows keeps CLI config under %APPDATA%.
	process.env.APPDATA = home
	delete process.env.KODY_API_TOKEN
	delete process.env.KODY_MCP_URL
	delete process.env.KODY_API_URL
	const requests: Array<Recorded> = []
	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = input instanceof Request ? input.url : String(input)
		const headers = new Headers(
			input instanceof Request ? input.headers : init?.headers,
		)
		const rawBody = typeof init?.body === 'string' ? init.body : null
		requests.push({
			url,
			authorization: headers.get('authorization'),
			body: rawBody ? JSON.parse(rawBody) : null,
		})
		return fetchStub(url, init)
	}) as typeof fetch
	// Windows Credential Manager (and macOS Keychain) are per-user, not per
	// HOME, so a token an earlier test saved would leak into this one.
	deleteStoredApiToken(apiUrl)
	try {
		return await run({ home, requests })
	} finally {
		deleteStoredApiToken(apiUrl)
		globalThis.fetch = previousFetch
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

function requestPath(url: string): string {
	return new URL(url).pathname
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function saveLogin(mcpUrl: string) {
	saveCredentials(
		{
			version: 1,
			mcpUrl,
			org: 'test-org',
			resource: mcpUrl,
			authorizationServerUrl: new URL(mcpUrl).origin,
			clientId: 'client-1',
			accessToken: 'kody_at_login_session',
			tokenType: 'bearer',
			expiresAt: Date.now() + 120_000,
			scope: 'org:execute package:read package:write',
		},
		createFileBackend(fileStorePath(mcpUrl)),
	)
}

async function capture(args: Array<string>) {
	let stdout = ''
	let stderr = ''
	const code = await runCli(args, {
		stdout: (text) => (stdout += text),
		stderr: (text) => (stderr += text),
	})
	return { code, stdout, stderr }
}

test('parseCliScopesFlag splits on commas or spaces and dedupes', () => {
	assert.equal(parseCliScopesFlag(undefined), undefined)
	assert.deepEqual(
		parseCliScopesFlag('org:execute, package:write org:execute'),
		['org:execute', 'package:write'],
	)
	assert.throws(() => parseCliScopesFlag(' , '), /at least one scope/)
})

test('auth bootstrap --scopes with --token mints through the Open API, then redeems and stores', async () => {
	await withCliEnv(
		(url) => {
			if (requestPath(url).endsWith('/openapi.json'))
				return json(openApiDocument)
			if (requestPath(url).endsWith('/v1/tokens/bootstrap'))
				return json(mintResponse(requestedScopes))
			if (requestPath(url).endsWith('/v1/tokens/bootstrap/redeem'))
				return json(redeemResponse)
			return json({ error: { code: 'not_found', message: url } }, 404)
		},
		async ({ requests }) => {
			const result = await capture([
				'auth',
				'bootstrap',
				'--scopes',
				requestedScopes.join(','),
				'--lifetime',
				'short',
				'--token',
				'kody_at_parent',
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 0, result.stderr)
			const mint = requests.find((request) =>
				requestPath(request.url).endsWith('/v1/tokens/bootstrap'),
			)
			assert.equal(mint?.authorization, 'Bearer kody_at_parent')
			assert.deepEqual(mint?.body, {
				scopes: requestedScopes,
				lifetime: 'short',
			})
			const redeem = requests.find((request) =>
				requestPath(request.url).endsWith('/v1/tokens/bootstrap/redeem'),
			)
			assert.equal(redeem?.authorization, null)
			assert.deepEqual(redeem?.body, {
				code: mintedCode,
				idle_ttl_seconds: 3600,
				max_lifetime_seconds: 86400,
			})
			assert.match(
				result.stdout,
				/scopes: org:execute, package:read, package:write/,
			)
			assert.doesNotMatch(result.stdout, /kody_at_|kody_bc_/)
			assert.equal(loadStoredApiToken(apiUrl)?.tokenId, 'tok_scoped_1')
		},
	)
})

test('resolveMintedRedeemLifetime trusts server clamp and coerces idle when max is lower', () => {
	assert.deepEqual(
		resolveMintedRedeemLifetime({
			idle_ttl_seconds: 3600,
			max_lifetime_seconds: 86400,
		}),
		{ kind: 'explicit', idleTtlSeconds: 3600, maxLifetimeSeconds: 86400 },
	)
	assert.deepEqual(
		resolveMintedRedeemLifetime({
			idle_ttl_seconds: 3600,
			max_lifetime_seconds: 45,
		}),
		{ kind: 'explicit', idleTtlSeconds: 45, maxLifetimeSeconds: 45 },
	)
})

test('auth bootstrap --scopes redeems server-clamped lifetimes without CLI flag validation', async () => {
	await withCliEnv(
		(url) => {
			if (requestPath(url).endsWith('/openapi.json'))
				return json(openApiDocument)
			if (requestPath(url).endsWith('/v1/tokens/bootstrap')) {
				return json({
					...mintResponse(requestedScopes),
					// Parent token remaining lifetime clamps max below requested idle
					// and below the CLI --idle-ttl-seconds minimum (60).
					idle_ttl_seconds: 3600,
					max_lifetime_seconds: 45,
				})
			}
			if (requestPath(url).endsWith('/v1/tokens/bootstrap/redeem'))
				return json(redeemResponse)
			return json({ error: { code: 'not_found', message: url } }, 404)
		},
		async ({ requests }) => {
			const result = await capture([
				'auth',
				'bootstrap',
				'--scopes',
				requestedScopes.join(','),
				'--lifetime',
				'short',
				'--token',
				'kody_at_parent',
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 0, result.stderr)
			const redeem = requests.find((request) =>
				requestPath(request.url).endsWith('/v1/tokens/bootstrap/redeem'),
			)
			assert.deepEqual(redeem?.body, {
				code: mintedCode,
				idle_ttl_seconds: 45,
				max_lifetime_seconds: 45,
			})
			assert.equal(loadStoredApiToken(apiUrl)?.tokenId, 'tok_scoped_1')
		},
	)
})

test('auth bootstrap --scopes explains how to widen when the token cannot grant a scope', async () => {
	await withCliEnv(
		(url) => {
			if (requestPath(url).endsWith('/openapi.json'))
				return json(openApiDocument)
			return json(
				{
					error: {
						code: 'invalid_input',
						message:
							'A token cannot grant scopes it does not hold: package:write.',
					},
				},
				400,
			)
		},
		async ({ requests }) => {
			const result = await capture([
				'auth',
				'bootstrap',
				'--scopes',
				'org:execute,package:write',
				'--lifetime',
				'short',
				'--token',
				'kody_at_parent',
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 1)
			assert.match(
				result.stderr,
				/cannot grant scopes it does not hold: package:write/,
			)
			assert.match(result.stderr, /kody login/)
			assert.ok(
				result.stderr.includes(
					'cliCredentialBootstrap({ lifetime: "short", scopes: ["org:execute", "package:write"] })',
				),
				result.stderr,
			)
			assert.equal(
				requests.some((request) =>
					requestPath(request.url).endsWith('/redeem'),
				),
				false,
			)
		},
	)
})

test('auth bootstrap --scopes with a kody login session mints through the Open API', async () => {
	const mcpUrl = 'https://login-scopes.test/mcp'
	await withCliEnv(
		(url) => {
			if (requestPath(url).endsWith('/openapi.json'))
				return json(openApiDocument)
			if (requestPath(url).endsWith('/v1/tokens/bootstrap'))
				return json(mintResponse(requestedScopes))
			if (requestPath(url).endsWith('/v1/tokens/bootstrap/redeem'))
				return json(redeemResponse)
			return json({ error: { code: 'not_found', message: url } }, 404)
		},
		async ({ requests }) => {
			saveLogin(mcpUrl)
			const result = await capture([
				'auth',
				'bootstrap',
				'--scopes',
				requestedScopes.join(','),
				'--lifetime',
				'short',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 0, result.stderr)
			const mint = requests.find((request) =>
				requestPath(request.url).endsWith('/v1/tokens/bootstrap'),
			)
			assert.equal(mint?.authorization, 'Bearer kody_at_login_session')
			assert.deepEqual(mint?.body, {
				scopes: requestedScopes,
				lifetime: 'short',
			})
			assert.equal(loadStoredApiToken(apiUrl)?.tokenId, 'tok_scoped_1')
			assert.doesNotMatch(result.stdout, /kody_at_|kody_bc_/)
		},
	)
})

test('auth bootstrap surfaces Open API errors from the login session', async () => {
	const mcpUrl = 'https://login-scopes-error.test/mcp'
	await withCliEnv(
		(url) => {
			if (requestPath(url).endsWith('/openapi.json'))
				return json(openApiDocument)
			if (requestPath(url).endsWith('/v1/tokens/bootstrap')) {
				return json(
					{
						error: {
							code: 'invalid_input',
							message: 'Unknown scope "nope:write".',
						},
					},
					400,
				)
			}
			return json({ error: { code: 'not_found', message: url } }, 404)
		},
		async ({ requests }) => {
			saveLogin(mcpUrl)
			const result = await capture([
				'auth',
				'bootstrap',
				'--scopes',
				'nope:write',
				'--lifetime',
				'short',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 1)
			assert.match(result.stderr, /Unknown scope "nope:write"/)
			assert.equal(
				requests.some((request) =>
					requestPath(request.url).endsWith('/redeem'),
				),
				false,
			)
		},
	)
})

test('auth bootstrap rejects --code with --scopes and prints the mint call', async () => {
	await withCliEnv(
		() => json({}, 500),
		async ({ requests }) => {
			const result = await capture([
				'auth',
				'bootstrap',
				'--code',
				mintedCode,
				'--scopes',
				'org:execute,package:write',
				'--lifetime',
				'short',
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 1)
			assert.match(result.stderr, /scopes are fixed when it is minted/)
			assert.ok(
				result.stderr.includes(
					'cliCredentialBootstrap({ lifetime: "short", scopes: ["org:execute", "package:write"] })',
				),
				result.stderr,
			)
			assert.equal(requests.length, 0)
		},
	)
})

test('auth bootstrap --scopes without any credential explains kody login and the MCP call', async () => {
	await withCliEnv(
		() => json({}, 500),
		async ({ requests }) => {
			const result = await capture([
				'auth',
				'bootstrap',
				'--scopes',
				'package:write',
				'--idle-ttl-seconds',
				'600',
				'--max-lifetime-seconds',
				'1200',
				'--mcp-url',
				'https://nobody.test/mcp',
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 1)
			assert.match(result.stderr, /kody login/)
			assert.ok(
				result.stderr.includes(
					'cliCredentialBootstrap({ idle_ttl_seconds: 600, max_lifetime_seconds: 1200, scopes: ["package:write"] })',
				),
				result.stderr,
			)
			assert.equal(requests.length, 0)
		},
	)
})

test('inferCliTokenLifetimeAlias preserves long tokens from absolute expiry', () => {
	const now = Date.parse('2026-10-13T19:00:00.000Z')
	assert.equal(inferCliTokenLifetimeAlias(null, now), 'short')
	assert.equal(
		inferCliTokenLifetimeAlias({ expiresAt: '2026-10-14T12:00:00.000Z' }, now),
		'short',
	)
	assert.equal(
		inferCliTokenLifetimeAlias(
			{
				expiresAt: '2026-11-01T00:00:00.000Z',
				maxExpiresAt: '2027-01-01T00:00:00.000Z',
			},
			now,
		),
		'long',
	)
})

test('readInsufficientScopeDetails reads platform required_permission, mint_scopes, and denial', () => {
	assert.deepEqual(
		readInsufficientScopeDetails({
			error: {
				code: 'insufficient_scope',
				message: 'x',
				details: {
					required_permission: 'package:write',
					denial: 'credential_scope',
					mint_scopes: ['org:execute', 'package:write'],
				},
			},
		}),
		{
			requiredScope: 'package:write',
			mintScopes: ['org:execute', 'package:write'],
			denial: 'credential_scope',
		},
	)
	assert.deepEqual(
		readInsufficientScopeDetails({ error: { code: 'insufficient_scope' } }),
		{
			requiredScope: null,
			mintScopes: null,
			denial: null,
		},
	)
})

test('insufficientScopeMessage names the missing scope and the exact mint commands', () => {
	const message = insufficientScopeMessage({
		requiredScope: 'package:write',
		mintScopes: ['org:execute', 'package:read', 'package:write'],
		denial: 'credential_scope',
	})
	assert.match(message, /missing "package:write"/)
	assert.ok(
		message.includes(
			'npx @kodycodes/cli auth bootstrap --lifetime short --scopes org:execute,package:read,package:write',
		),
		message,
	)
	assert.ok(
		message.includes(
			'cliCredentialBootstrap({ lifetime: "short", scopes: ["org:execute", "package:read", "package:write"] })',
		),
		message,
	)

	const longHint = insufficientScopeMessage({
		requiredScope: 'package:write',
		mintScopes: ['org:execute', 'package:write'],
		currentLifetime: 'long',
	})
	assert.ok(
		longHint.includes(
			'npx @kodycodes/cli auth bootstrap --lifetime long --scopes org:execute,package:write',
		),
		longHint,
	)
	assert.ok(
		longHint.includes(
			'cliCredentialBootstrap({ lifetime: "long", scopes: ["org:execute", "package:write"] })',
		),
		longHint,
	)
	assert.doesNotMatch(longHint, /--lifetime short/)

	const fromCurrent = insufficientScopeMessage({
		requiredScope: 'search:read',
		currentScopes: ['org:read', 'org:execute'],
	})
	assert.ok(
		fromCurrent.includes(
			cliBootstrapScopesCommand(['org:execute', 'org:read', 'search:read']),
		),
	)

	const roleDenial = insufficientScopeMessage({
		requiredScope: 'package:write',
		denial: 'missing_permission',
	})
	assert.match(roleDenial, /org role does not grant "package:write"/)
	assert.doesNotMatch(roleDenial, /auth bootstrap/)

	const unknownScopes = insufficientScopeMessage({
		requiredScope: 'package:write',
	})
	assert.ok(
		unknownScopes.includes(
			cliBootstrapMintCall(['<current scopes>', 'package:write']),
		),
	)
})

test('CapabilityProxy insufficient_scope prints the platform mint scopes as commands', async () => {
	const fetchFn = (async () =>
		json(
			{
				error: {
					code: 'insufficient_scope',
					message: 'This credential is not scoped for package:write.',
					details: {
						required_permission: 'package:write',
						denial: 'credential_scope',
						mint_scopes: ['org:execute', 'package:write'],
					},
				},
			},
			403,
		)) as typeof fetch
	await assert.rejects(
		() =>
			openCapabilityProxySession({
				apiUrl: 'https://api.kody.codes',
				token: 'kody_at_x',
				fetchFn,
			}),
		(error: Error) => {
			assert.ok(
				error.message.includes(
					'npx @kodycodes/cli auth bootstrap --lifetime short --scopes org:execute,package:write',
				),
				error.message,
			)
			return true
		},
	)
})
