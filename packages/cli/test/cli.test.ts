import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	apiUrlFrom,
	buildExecuteToolArgs,
	executeSourcesConflict,
	argvIncludesJsonFlag,
	formatCliErrorJson,
	packagePublishParams,
	resolvePackagePublishTarget,
	parseApiParamsJson,
	resolveApiToken,
	resolveCommand,
	resolveLocalExecuteBearer,
	runCli,
	shouldUseApiToken,
} from '../src/cli.js'
import { OpenApiError, clearOpenApiRouteCache } from '../src/open-api-client.js'
import { buildUsage } from '../src/help.js'
import { readPackageVersion } from '../src/package-info.js'
import { isPairedApiUrl } from '../src/api-token.js'
import { type StoredApiToken } from '../src/api-token-store.js'
import { modernMcpProtocolVersion } from '../src/defaults.js'
import { formatToolResult } from '../src/tool-result.js'
import { redact } from '../src/redact.js'
import {
	createFileBackend,
	fileStorePath,
	saveCredentials,
	type StoredCredentials,
} from '../src/store.js'

function sampleLoginCredentials(
	overrides: Partial<StoredCredentials> = {},
): StoredCredentials {
	return {
		version: 1,
		mcpUrl: 'https://kody.codes/mcp',
		resource: 'https://kody.codes/mcp',
		authorizationServerUrl: 'https://kody.codes',
		clientId: 'client-1',
		accessToken: 'oauth-access-from-login',
		refreshToken: 'refresh-1',
		tokenType: 'bearer',
		expiresAt: Date.now() + 120_000,
		scope: 'profile email',
		...overrides,
	}
}

test('resolveCommand maps subcommands and flags', () => {
	assert.equal(resolveCommand(['search', 'what can you do']).command, 'search')
	assert.equal(resolveCommand(['api', 'usageGet']).command, 'api')
	assert.equal(resolveCommand(['api', 'usageGet']).positionals[0], 'usageGet')
	assert.equal(
		resolveCommand(['package', 'publish', '@acme/pkg']).command,
		'package',
	)
	assert.equal(resolveCommand(['package', 'publish']).positionals[0], 'publish')
	assert.equal(resolveCommand(['install', '--yes']).command, 'install')
	assert.equal(
		resolveCommand(['auth', 'bootstrap', '--code', 'kody_bc_x']).command,
		'auth',
	)
	assert.equal(
		resolveCommand(['auth', 'bootstrap']).positionals[0],
		'bootstrap',
	)
	assert.equal(resolveCommand(['--help']).command, 'help')
	assert.equal(resolveCommand(['--version']).command, 'version')
	assert.equal(
		resolveCommand(['execute', '--file', 'mod.js']).values.file,
		'mod.js',
	)
	assert.equal(resolveCommand(['login', '--org', 'Acme']).values.org, 'Acme')
	assert.equal(
		resolveCommand(['execute', '--invoke', 'kody:@scope/pkg/export']).values
			.invoke,
		'kody:@scope/pkg/export',
	)
	assert.throws(() => resolveCommand(['explode']), /Unknown command "explode"/)
	assert.throws(() => resolveCommand(['explode']), /kody --help/)
	assert.throws(
		() => resolveCommand(['explode']),
		(error: unknown) =>
			error instanceof Error &&
			!error.message.includes('Install Kody as a remote MCP server'),
	)
})

test('auth help puts agent cliCredentialBootstrap before kody login', () => {
	const text = buildUsage({ orgs: [] })
	assert.match(
		text,
		/auth bootstrap[\s\S]*Agents on Kody MCP: call `cliCredentialBootstrap`[\s\S]*cli_command[\s\S]*never ask a human to paste a token[\s\S]*Humans: `kody login`/,
	)
})

test('help header version matches --version (same package.json source)', async () => {
	const version = readPackageVersion()
	assert.match(
		buildUsage({ orgs: [] }),
		new RegExp(`^Kody CLI ${version.replace(/\./g, '\\.')}\\b`),
	)
	let stdout = ''
	const code = await runCli(['--version'], {
		stdout: (text) => {
			stdout += text
		},
		stderr: () => {},
	})
	assert.equal(code, 0)
	assert.equal(stdout.trim(), version)
})

test('packagePublishParams maps positional UUID vs kody_id; --params wins', () => {
	assert.deepEqual(packagePublishParams({}), {})
	assert.deepEqual(packagePublishParams({ positional: '@acme/pkg' }), {
		kody_id: '@acme/pkg',
	})
	assert.deepEqual(
		packagePublishParams({
			positional: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		}),
		{ package_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
	)
	assert.deepEqual(
		packagePublishParams({
			positional: '@acme/pkg',
			paramsJson: '{"kody_id":"@other/x","allow_force":true}',
		}),
		{ kody_id: '@other/x', allow_force: true },
	)
})

test('resolvePackagePublishTarget turns a package name into the package_id the route needs', async () => {
	const packages = [
		{
			package_id: 'id-asteroids',
			kody_id: 'asteroids',
			name: '@kentcdodds/asteroids',
		},
		{
			package_id: 'id-kit',
			kody_id: 'package-app-kit',
			name: '@kentcdodds/package-app-kit',
		},
		{ package_id: 'id-dup-a', kody_id: 'dup', name: '@a/dup' },
		{ package_id: 'id-dup-b', kody_id: 'dup', name: '@b/dup' },
	]
	const calls: Array<string> = []
	const call = async (operationId: string) => {
		calls.push(operationId)
		return { packages }
	}
	assert.deepEqual(
		await resolvePackagePublishTarget(
			{ kody_id: '@kentcdodds/asteroids', allow_force: true },
			call,
		),
		{ package_id: 'id-asteroids', allow_force: true },
	)
	assert.deepEqual(
		await resolvePackagePublishTarget({ kody_id: 'package-app-kit' }, call),
		{
			package_id: 'id-kit',
		},
	)
	assert.deepEqual(calls, ['packageList', 'packageList'])
	assert.deepEqual(
		await resolvePackagePublishTarget({ package_id: 'given' }, call),
		{
			package_id: 'given',
		},
	)
	assert.equal(calls.length, 2, 'a package_id needs no lookup')
	await assert.rejects(
		resolvePackagePublishTarget({ kody_id: '@someone/asteroids' }, call),
		/No saved package named "@someone\/asteroids".*@kentcdodds\/asteroids/,
	)
	await assert.rejects(
		resolvePackagePublishTarget({ kody_id: 'dup' }, call),
		/matches several saved packages \(@a\/dup = id-dup-a, @b\/dup = id-dup-b\)/,
	)
})

test('unknown commands write a short error to stderr only (no help on stdout)', async () => {
	let stdout = ''
	let stderr = ''
	const code = await runCli(['git-credential-typo'], {
		stdout: (text) => {
			stdout += text
		},
		stderr: (text) => {
			stderr += text
		},
	})
	assert.equal(code, 1)
	assert.equal(stdout, '')
	assert.match(stderr, /Unknown command "git-credential-typo"/)
	assert.doesNotMatch(stderr, /Install Kody as a remote MCP server/)
})

test('argvIncludesJsonFlag and formatCliErrorJson expose additive sent', () => {
	assert.equal(argvIncludesJsonFlag(['package', 'publish', '--json']), true)
	assert.equal(argvIncludesJsonFlag(['package', 'publish']), false)
	assert.deepEqual(
		formatCliErrorJson(
			new OpenApiError('not sent', { sent: false, code: 'network' }),
		),
		{
			error: true,
			message: 'not sent',
			code: 'network',
			sent: false,
		},
	)
	assert.deepEqual(
		formatCliErrorJson(new OpenApiError('maybe', { sent: 'unknown' })),
		{
			error: true,
			message: 'maybe',
			sent: 'unknown',
		},
	)
})

test('runCli --json prints sent:false on connect-phase Open API failures', async () => {
	const server = createServer()
	await new Promise<void>((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve()),
	)
	const { port } = server.address() as AddressInfo
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()))
	})

	let stdout = ''
	let stderr = ''
	const code = await runCli(
		[
			'api',
			'metaGetCurrentUser',
			'--token',
			'kody_at_test_token_for_network',
			'--api-url',
			`http://127.0.0.1:${port}`,
			'--json',
		],
		{
			stdout: (text) => {
				stdout += text
			},
			stderr: (text) => {
				stderr += text
			},
		},
	)
	assert.equal(code, 1)
	assert.match(stderr, /The request was not sent/)
	const body = JSON.parse(stdout) as {
		error: boolean
		sent?: false | 'unknown'
		message: string
	}
	assert.equal(body.error, true)
	assert.equal(body.sent, false)
	assert.match(body.message, /The request was not sent/)
})

test('parseApiParamsJson requires a flat object', () => {
	assert.deepEqual(parseApiParamsJson(undefined), {})
	assert.deepEqual(parseApiParamsJson('{"query":"email"}'), { query: 'email' })
	assert.throws(() => parseApiParamsJson('['), /valid JSON/)
	assert.throws(() => parseApiParamsJson('[]'), /JSON object/)
	assert.throws(() => parseApiParamsJson('"x"'), /JSON object/)
})

test('resolveCommand parses execute --local flags', () => {
	const { values } = resolveCommand([
		'execute',
		'--local',
		'--allow-private-network',
		'--token',
		'tok',
		'--api-url',
		'http://localhost:8787',
		'--file',
		'mod.js',
	])
	assert.equal(values.local, true)
	assert.equal(values['allow-private-network'], true)
	assert.equal(values.token, 'tok')
	assert.equal(values['api-url'], 'http://localhost:8787')
})

test('unknown --code-file is rejected and suggests --file', () => {
	assert.throws(
		() => resolveCommand(['execute', '--local', '--code-file', 'mod.js']),
		/Unknown option "--code-file".*Did you mean --file\?/,
	)
	assert.throws(
		() =>
			resolveCommand(['execute', '--local', '--file', '--code-file', 'mod.js']),
		/Unknown option "--code-file".*Did you mean --file\?/,
	)
	assert.equal(
		resolveCommand(['execute', '--local', '--file=--code-file']).values.file,
		'--code-file',
	)
})

test('unknown flags write a usage error to stderr and do not run the module path', async () => {
	let stdout = ''
	let stderr = ''
	const code = await runCli(
		['execute', '--local', '--code-file', '/tmp/m.js'],
		{
			stdout: (text) => {
				stdout += text
			},
			stderr: (text) => {
				stderr += text
			},
		},
	)
	assert.equal(code, 1)
	assert.equal(stdout, '')
	assert.match(stderr, /Unknown option "--code-file"/)
	assert.match(stderr, /Did you mean --file\?/)
	assert.doesNotMatch(stderr, /Invalid regular expression/)
	assert.doesNotMatch(stderr, /workerd/)
})

test('allow-private-network is limited to execute --local', async () => {
	let stderr = ''
	const code = await runCli(
		['execute', '--allow-private-network', '--code', 'export default () => 1'],
		{ stdout: () => {}, stderr: (text) => (stderr += text) },
	)
	assert.equal(code, 1)
	assert.match(
		stderr,
		/--allow-private-network can only be used with execute --local, execute --target mock, or kody dev/,
	)
})

test('allow-private-network is allowed with execute --target mock', async () => {
	const previous = process.env.KODY_WORKERD_PATH
	process.env.KODY_WORKERD_PATH =
		'/nonexistent/workerd-for-private-network-guard'
	let stderr = ''
	try {
		await runCli(
			[
				'execute',
				'--target',
				'mock',
				'--allow-private-network',
				'--code',
				'export default () => ({ ok: true })',
			],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
	} finally {
		if (previous === undefined) delete process.env.KODY_WORKERD_PATH
		else process.env.KODY_WORKERD_PATH = previous
	}
	// Must not fail the private-network guard (workerd path fails later).
	assert.doesNotMatch(stderr, /--allow-private-network can only be used/)
	assert.match(stderr, /workerd|ENOENT|nonexistent|spawn/i)
})

test('resolveApiToken prefers --token, falls back to KODY_API_TOKEN, and requires one', () => {
	assert.equal(
		resolveApiToken({ token: 'flag' }, { KODY_API_TOKEN: 'env' }),
		'flag',
	)
	assert.equal(resolveApiToken({}, { KODY_API_TOKEN: ' env ' }), 'env')
	assert.throws(
		() => resolveApiToken({}, {}),
		/not authenticated[\s\S]*cliCredentialBootstrap[\s\S]*kody\.cliCredentialBootstrap[\s\S]*cli_command[\s\S]*never ask a human to paste a token[\s\S]*kody login[\s\S]*tokenCreate[\s\S]*KODY_API_TOKEN/,
	)
})

test('resolveLocalExecuteBearer prefers API token over login OAuth', async () => {
	const token = await resolveLocalExecuteBearer({
		tokenValues: { token: 'kody_at_flag' },
		env: { KODY_API_TOKEN: 'kody_at_env' },
		ensureCredentials: async () => {
			throw new Error('login should not be consulted when a token is set')
		},
	})
	assert.equal(token, 'kody_at_flag')
})

test('resolveLocalExecuteBearer uses login OAuth when no API token is set', async () => {
	const token = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		loadApiToken: () => null,
		ensureCredentials: async () => sampleLoginCredentials(),
	})
	assert.equal(token, 'oauth-access-from-login')
})

test('default paired API and MCP URLs allow login OAuth', async () => {
	let ensureCalls = 0
	const token = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		loadApiToken: () => null,
		ensureCredentials: async () => {
			ensureCalls += 1
			return sampleLoginCredentials()
		},
	})
	assert.equal(token, 'oauth-access-from-login')
	assert.equal(ensureCalls, 1)
	assert.equal(isPairedApiUrl(), true)
})

test('mismatched API origin rejects login OAuth before ensure or fetch', async () => {
	let ensureCalls = 0
	let fetchCalls = 0
	await assert.rejects(
		() =>
			resolveLocalExecuteBearer({
				tokenValues: {},
				env: {},
				mcpUrl: 'https://kody.codes/mcp',
				apiUrl: 'https://api.other.test',
				loadApiToken: () => null,
				fetchFn: (async () => {
					fetchCalls += 1
					throw new Error('fetch must not run')
				}) as typeof fetch,
				ensureCredentials: async () => {
					ensureCalls += 1
					return sampleLoginCredentials()
				},
			}),
		/kody login credentials.*https:\/\/api\.kody\.codes.*api\.other\.test/,
	)
	assert.equal(ensureCalls, 0)
	assert.equal(fetchCalls, 0)
})

test('explicit and stored API tokens remain usable on mismatched origins', async () => {
	const apiUrl = 'https://api.other.test'
	const mcpUrl = 'https://kody.codes/mcp'
	const explicitToken = await resolveLocalExecuteBearer({
		tokenValues: { token: 'explicit-token' },
		env: {},
		mcpUrl,
		apiUrl,
		ensureCredentials: async () => {
			throw new Error('login OAuth must not be consulted')
		},
	})
	assert.equal(explicitToken, 'explicit-token')

	const envToken = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: { KODY_API_TOKEN: 'env-token' },
		mcpUrl,
		apiUrl,
		ensureCredentials: async () => {
			throw new Error('login OAuth must not be consulted')
		},
	})
	assert.equal(envToken, 'env-token')

	const storedToken = await resolveLocalExecuteBearer({
		tokenValues: {},
		env: {},
		mcpUrl,
		apiUrl,
		loadApiToken: (requestedApiUrl) => ({
			version: 1,
			apiUrl: requestedApiUrl ?? apiUrl,
			token: 'stored-token',
			tokenId: 'stored-id',
		}),
		ensureCredentials: async () => {
			throw new Error('login OAuth must not be consulted')
		},
	})
	assert.equal(storedToken, 'stored-token')
})

test('paired preview and loopback API origins allow login OAuth', async () => {
	for (const [apiUrl, mcpUrl] of [
		[
			'https://kody-pr-42-api.kody.workers.dev',
			'https://kody-pr-42.kody.workers.dev/mcp',
		],
		['http://localhost:8788', 'http://127.0.0.1:8787/mcp'],
	]) {
		assert.equal(isPairedApiUrl(apiUrl, mcpUrl), true)
		const token = await resolveLocalExecuteBearer({
			tokenValues: {},
			env: {},
			apiUrl,
			mcpUrl,
			loadApiToken: () => null,
			ensureCredentials: async () => sampleLoginCredentials({ mcpUrl }),
		})
		assert.equal(token, 'oauth-access-from-login')
	}
	assert.equal(
		isPairedApiUrl(
			'https://api.kody-pr-42.kody.workers.dev',
			'https://kody-pr-42.kody.workers.dev/mcp',
		),
		false,
	)
	assert.equal(
		isPairedApiUrl(
			'https://unrelated-api.workers.dev',
			'https://kody-pr-42.kody.workers.dev/mcp',
		),
		false,
	)
})

test('resolveLocalExecuteBearer fails clearly when neither login nor token is available', async () => {
	await assert.rejects(
		() =>
			resolveLocalExecuteBearer({
				tokenValues: {},
				env: {},
				loadApiToken: () => null,
				ensureCredentials: async () => {
					throw new Error('Not logged in')
				},
			}),
		/execute --local: not authenticated[\s\S]*cliCredentialBootstrap[\s\S]*cli_command[\s\S]*never ask a human to paste a token[\s\S]*kody login[\s\S]*tokenCreate/,
	)
})

test('apiUrlFrom defaults to api.kody.codes', () => {
	assert.equal(apiUrlFrom({}, {}), 'https://api.kody.codes')
	assert.equal(
		apiUrlFrom({}, { KODY_API_URL: 'http://localhost:8787' }),
		'http://localhost:8787',
	)
	assert.equal(
		apiUrlFrom({ apiUrl: 'http://x' }, { KODY_API_URL: 'http://y' }),
		'http://x',
	)
})

test('shouldUseApiToken prefers explicit --token and env token when not logged in', () => {
	assert.equal(
		shouldUseApiToken({
			tokenValues: { token: 'flag' },
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: true,
		}),
		true,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: { KODY_API_TOKEN: 'env-tok' },
			hasSession: false,
		}),
		true,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: { KODY_API_TOKEN: 'env-tok' },
			hasSession: true,
		}),
		false,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: false,
		}),
		false,
	)
})

test('shouldUseApiToken treats stored bootstrap token like env when not logged in', () => {
	const stored: StoredApiToken = {
		version: 1,
		apiUrl: 'https://api.kody.codes',
		token: 'kody_at_stored',
		tokenId: 'tok_stored',
	}
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: false,
			loadApiToken: () => stored,
		}),
		true,
	)
	assert.equal(
		shouldUseApiToken({
			tokenValues: {},
			mcpUrl: 'https://kody.codes/mcp',
			allowEnvWithoutLogin: true,
			env: {},
			hasSession: true,
			loadApiToken: () => stored,
		}),
		false,
	)
})

test('resolveApiToken falls back to a stored bootstrap token', () => {
	const stored: StoredApiToken = {
		version: 1,
		apiUrl: 'https://api.kody.codes',
		token: 'kody_at_stored',
		tokenId: 'tok_stored',
	}
	assert.equal(
		resolveApiToken({}, {}, 'this command', {
			loadApiToken: () => stored,
		}),
		'kody_at_stored',
	)
})

test('api command calls Open API by operationId with scoped token', async () => {
	clearOpenApiRouteCache()
	const previousFetch = globalThis.fetch
	const calls: Array<string> = []
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(String(input))
		calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`)
		if (url.pathname === '/openapi.json') {
			return new Response(
				JSON.stringify({
					paths: {
						'/v1/account/usage': { get: { operationId: 'usageGet' } },
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (url.pathname === '/v1/account/usage') {
			assert.equal(
				init?.headers && (init.headers as Record<string, string>).authorization,
				'Bearer kody_at_test',
			)
			return new Response(JSON.stringify({ plan: 'pro' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return new Response('nope', { status: 404 })
	}) as typeof fetch
	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(
			[
				'api',
				'usageGet',
				'--params',
				'{}',
				'--token',
				'kody_at_test',
				'--api-url',
				'https://api.kody.codes',
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: (text) => {
					stderr += text
				},
			},
		)
		assert.equal(code, 0, stderr)
		assert.match(stdout, /"plan": "pro"/)
		assert.deepEqual(calls, ['GET /openapi.json', 'GET /v1/account/usage'])
	} finally {
		globalThis.fetch = previousFetch
		clearOpenApiRouteCache()
	}
})

test('api command refuses bootstrap redeem and documents auth bootstrap', async () => {
	let stderr = ''
	const code = await runCli(
		[
			'api',
			'cliCredentialBootstrapRedeem',
			'--params',
			'{"code":"kody_bc_x"}',
			'--token',
			'tok',
		],
		{
			stdout: () => undefined,
			stderr: (text) => {
				stderr += text
			},
		},
	)
	assert.equal(code, 1)
	assert.match(stderr, /auth bootstrap --code/)
})

test('help documents the api command', async () => {
	let stdout = ''
	const code = await runCli(['help'], {
		stdout: (text) => {
			stdout += text
		},
	})
	assert.equal(code, 0)
	assert.match(stdout, /kody api <operationId>/)
	assert.match(stdout, /usageGet/)
	assert.match(stdout, /kody login \[--mcp-url <url>\] \[--org <slug>\]/)
	assert.match(stdout, /kody login --org acme/)
})

test('--org selects an org for org-scoped commands and rejects a blank slug', async () => {
	let stderr = ''
	const missing = await runCli(['search', '--org', 'acme'], {
		stderr: (text) => {
			stderr += text
		},
	})
	assert.equal(missing, 1)
	assert.match(stderr, /No login stored for org "acme"|Not logged in/)

	stderr = ''
	const blank = await runCli(['login', '--org', '   '], {
		stderr: (text) => {
			stderr += text
		},
	})
	assert.equal(blank, 1)
	assert.match(stderr, /kody login --org acme/)

	stderr = ''
	const wrongCommand = await runCli(['install', '--org', 'acme'], {
		stderr: (text) => {
			stderr += text
		},
	})
	assert.equal(wrongCommand, 1)
	assert.match(stderr, /`--org` is not used with `kody install`/)
})

type ApiStub = {
	apiUrl: string
	requests: Array<{ method: string; url: string; authorization: string | null }>
	close: () => Promise<void>
}

/** Loopback stand-in for api.kody.codes; CapabilityProxy requests go over node:http. */
async function startApiStub(
	respond: (request: { method: string; url: string }) => {
		status: number
		body: unknown
	},
): Promise<ApiStub> {
	const requests: ApiStub['requests'] = []
	const server = createServer((request, response) => {
		request.resume()
		const entry = {
			method: request.method ?? '',
			url: request.url ?? '',
			authorization: request.headers.authorization ?? null,
		}
		requests.push(entry)
		const { status, body } = respond(entry)
		response.writeHead(status, { 'content-type': 'application/json' })
		response.end(JSON.stringify(body))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		apiUrl: `http://127.0.0.1:${port}`,
		requests,
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

test('execute with --token (no --local) posts /v1/execute and never requires login', async () => {
	const previousMcpUrl = process.env.KODY_MCP_URL
	process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
	const api = await startApiStub(() => ({
		status: 200,
		body: { ok: true, result: { cloud: true }, logs: [] },
	}))
	let stdout = ''
	let stderr = ''
	try {
		const code = await runCli(
			[
				'execute',
				'--token',
				'tok',
				'--api-url',
				api.apiUrl,
				'--code',
				'export default async () => ({ cloud: true })',
			],
			{
				stdout: (text) => (stdout += text),
				stderr: (text) => (stderr += text),
			},
		)
		assert.equal(code, 0, stderr)
	} finally {
		await api.close()
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.deepEqual(JSON.parse(stdout), { cloud: true })
	assert.deepEqual(
		api.requests.map((request) => `${request.method} ${request.url}`),
		['POST /v1/execute'],
	)
	assert.equal(api.requests[0]?.authorization, 'Bearer tok')
})

test('execute without token or login prompts clearly', async () => {
	const previousMcpUrl = process.env.KODY_MCP_URL
	const previousToken = process.env.KODY_API_TOKEN
	process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
	delete process.env.KODY_API_TOKEN
	let stderr = ''
	try {
		const code = await runCli(['execute', '--code', 'export default () => 1'], {
			stdout: () => {},
			stderr: (text) => (stderr += text),
		})
		assert.equal(code, 1)
	} finally {
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
	}
	assert.match(stderr, /Not authenticated/)
	assert.match(stderr, /cliCredentialBootstrap/)
	assert.match(stderr, /cli_command/)
	assert.match(stderr, /never ask a human to paste a token/)
	assert.match(stderr, /kody login/)
	assert.match(stderr, /tokenCreate/)
	assert.match(stderr, /org:execute/)
	assert.match(stderr, /KODY_API_TOKEN/)
})

test('execute --local without token or login fails clearly', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	const previousXdg = process.env.XDG_CONFIG_HOME
	const xdg = mkdtempSync(join(tmpdir(), 'kody-cli-no-login-'))
	process.env.XDG_CONFIG_HOME = xdg
	delete process.env.KODY_API_TOKEN
	let stderr = ''
	try {
		const code = await runCli(
			['execute', '--local', '--code', 'export default () => 1'],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 1)
	} finally {
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
	}
	assert.match(stderr, /execute --local: not authenticated/)
	assert.match(stderr, /cliCredentialBootstrap/)
	assert.match(stderr, /cli_command/)
	assert.match(stderr, /never ask a human to paste a token/)
	assert.match(stderr, /kody login/)
	assert.match(stderr, /tokenCreate|KODY_API_TOKEN/)
	assert.doesNotMatch(stderr, /workerd did not start|Could not start workerd/)
})

test('execute --local with login (no API token) sends OAuth access token as Bearer', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousMcpUrl = process.env.KODY_MCP_URL
	const xdg = mkdtempSync(join(tmpdir(), 'kody-cli-login-local-'))
	process.env.XDG_CONFIG_HOME = xdg
	delete process.env.KODY_API_TOKEN
	// Loopback API origins pair only with a loopback MCP origin; the stored login is fresh, so it is never contacted.
	const mcpUrl = 'http://127.0.0.1:9/mcp'
	process.env.KODY_MCP_URL = mcpUrl
	const credentials = sampleLoginCredentials({ mcpUrl, resource: mcpUrl })
	saveCredentials(credentials, createFileBackend(fileStorePath(mcpUrl)))
	const api = await startApiStub(() => ({
		status: 403,
		body: {
			error: { code: 'feature_disabled', message: 'local-execute is off' },
		},
	}))

	let stderr = ''
	try {
		const code = await runCli(
			[
				'execute',
				'--local',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				api.apiUrl,
				'--code',
				'export default () => 1',
			],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 1)
	} finally {
		await api.close()
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.deepEqual(
		api.requests.map((request) => request.authorization),
		[`Bearer ${credentials.accessToken}`],
	)
	assert.match(stderr, /feature_disabled[\s\S]*local-execute/)
	assert.equal(stderr.includes(credentials.accessToken), false)
})

test('execute --local prefers --token over a stored login session', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	const previousXdg = process.env.XDG_CONFIG_HOME
	const previousMcpUrl = process.env.KODY_MCP_URL
	const xdg = mkdtempSync(join(tmpdir(), 'kody-cli-token-wins-'))
	process.env.XDG_CONFIG_HOME = xdg
	delete process.env.KODY_API_TOKEN
	const mcpUrl = 'https://token-wins.test/mcp'
	process.env.KODY_MCP_URL = mcpUrl
	saveCredentials(
		sampleLoginCredentials({
			mcpUrl,
			resource: mcpUrl,
			accessToken: 'oauth-should-not-win',
		}),
		createFileBackend(fileStorePath(mcpUrl)),
	)
	const api = await startApiStub(() => ({
		status: 403,
		body: {
			error: { code: 'feature_disabled', message: 'local-execute is off' },
		},
	}))

	let stderr = ''
	try {
		const code = await runCli(
			[
				'execute',
				'--local',
				'--token',
				'kody_at_explicit',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				api.apiUrl,
				'--code',
				'export default () => 1',
			],
			{ stdout: () => {}, stderr: (text) => (stderr += text) },
		)
		assert.equal(code, 1)
	} finally {
		await api.close()
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
		else process.env.KODY_MCP_URL = previousMcpUrl
	}
	assert.deepEqual(
		api.requests.map((request) => request.authorization),
		['Bearer kody_at_explicit'],
	)
	assert.match(stderr, /feature_disabled/)
})

test('execute token paths surface feature_disabled and insufficient_scope', async () => {
	const previousToken = process.env.KODY_API_TOKEN
	delete process.env.KODY_API_TOKEN
	let statusBody: unknown = null
	const server = createServer((request, response) => {
		request.resume()
		response.writeHead(403, { 'content-type': 'application/json' })
		response.end(JSON.stringify(statusBody))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	const moduleArgs = [
		'--api-url',
		`http://127.0.0.1:${port}`,
		'--code',
		'export default () => 1',
	]
	const cases: Array<{
		args: Array<string>
		statusBody: unknown
		pattern: RegExp
	}> = [
		{
			args: ['execute', '--local', '--token', 'tok', ...moduleArgs],
			statusBody: {
				error: { code: 'feature_disabled', message: 'local-execute is off' },
			},
			pattern: /feature_disabled[\s\S]*local-execute/,
		},
		{
			args: ['execute', '--local', '--token', 'tok', ...moduleArgs],
			statusBody: {
				error: {
					code: 'insufficient_scope',
					message: 'need local-execute',
					details: { required_scope: 'local-execute' },
				},
			},
			pattern:
				/insufficient_scope[\s\S]*cliCredentialBootstrap[\s\S]*tokenCreate[\s\S]*local-execute/,
		},
		{
			args: ['execute', '--token', 'tok', ...moduleArgs],
			statusBody: {
				error: { code: 'feature_disabled', message: 'local-execute is off' },
			},
			pattern: /feature_disabled[\s\S]*local-execute/,
		},
		{
			args: ['execute', '--token', 'tok', ...moduleArgs],
			statusBody: {
				error: {
					code: 'insufficient_scope',
					message: 'need email:send',
					details: { required_scopes: ['local-execute', 'email:send'] },
				},
			},
			pattern: /insufficient_scope[\s\S]*email:send[\s\S]*tokenCreate/,
		},
	]
	try {
		for (const entry of cases) {
			statusBody = entry.statusBody
			let stderr = ''
			const code = await runCli(entry.args, {
				stdout: () => {},
				stderr: (text) => (stderr += text),
			})
			assert.equal(code, 1, stderr)
			assert.match(stderr, entry.pattern)
		}
	} finally {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
		if (previousToken === undefined) delete process.env.KODY_API_TOKEN
		else process.env.KODY_API_TOKEN = previousToken
	}
})

test('execute --local --invoke kody:@… mints passthrough (does not reject)', async () => {
	// Without auth / package-graph the run fails later — but not with the old
	// "--local runs a module you provide" rejection that forced a --code wrapper.
	let stderr = ''
	const code = await runCli(
		['execute', '--local', '--invoke', 'kody:@me/pkg/export'],
		{
			stdout: () => {},
			stderr: (text) => (stderr += text),
		},
	)
	assert.equal(code, 1)
	assert.doesNotMatch(stderr, /--local runs a module you provide/)
	assert.doesNotMatch(
		stderr,
		/neither a local package export nor a published package specifier/,
	)
})

test('execute --local --invoke rejects non-package export keys outside a package', async () => {
	const previous = process.cwd()
	const root = await mkdtemp(join(tmpdir(), 'kody-invoke-bad-'))
	let stderr = ''
	try {
		process.chdir(root)
		const code = await runCli(
			['execute', '--local', '--invoke', './not-an-export'],
			{
				stdout: () => {},
				stderr: (text) => (stderr += text),
			},
		)
		assert.equal(code, 1)
		assert.match(
			stderr,
			/neither a local package export nor a published package specifier/,
		)
	} finally {
		process.chdir(previous)
		await rm(root, { recursive: true, force: true })
	}
})

test('buildExecuteToolArgs passes invoke without code and keeps params', () => {
	assert.deepEqual(
		buildExecuteToolArgs({
			invoke: 'kody:@cameronpak/skills/skill-get',
			paramsJson: '{"name":"demo"}',
			conversationId: 'conv-1',
		}),
		{
			invoke: 'kody:@cameronpak/skills/skill-get',
			params: { name: 'demo' },
			conversationId: 'conv-1',
		},
	)
})

test('buildExecuteToolArgs rejects invoke combined with code', () => {
	assert.throws(
		() =>
			buildExecuteToolArgs({
				invoke: 'kody:@scope/pkg/export',
				code: 'export default async function main() {}',
			}),
		/--invoke cannot be combined/,
	)
})

test('executeSourcesConflict rejects invoke with code or file flags', () => {
	assert.equal(
		executeSourcesConflict({
			invoke: 'kody:@scope/pkg/export',
			hasCodeFlag: true,
			hasFileFlag: false,
			positionalModule: '',
		}),
		true,
	)
	assert.equal(
		executeSourcesConflict({
			invoke: 'kody:@scope/pkg/export',
			hasCodeFlag: false,
			hasFileFlag: true,
			positionalModule: '',
		}),
		true,
	)
	assert.equal(
		executeSourcesConflict({
			invoke: 'kody:@scope/pkg/export',
			hasCodeFlag: false,
			hasFileFlag: false,
			positionalModule: '',
		}),
		false,
	)
})

test('buildExecuteToolArgs errors when neither invoke nor code is provided', () => {
	assert.throws(
		() => buildExecuteToolArgs({}),
		/Provide --invoke, --code, --file/,
	)
	assert.throws(
		() => buildExecuteToolArgs({ code: '' }),
		/Provide --invoke, --code, --file/,
	)
	assert.throws(
		() => buildExecuteToolArgs({ invoke: '' }),
		/Provide a non-empty --invoke value/,
	)
})

test('formatToolResult prefers text content unless --json', () => {
	const result = {
		content: [{ type: 'text', text: 'hello' }],
		structuredContent: { ok: true },
	}
	assert.equal(formatToolResult(result, false), 'hello\n')
	assert.match(formatToolResult(result, true), /"ok": true/)
})

test('redact strips token-looking assignments', () => {
	assert.equal(
		redact('access_token=abc123 refresh_token: xyz'),
		'access_token=[redacted] refresh_token=[redacted]',
	)
})

test('CLI pins the stateless MCP protocol revision', () => {
	assert.equal(modernMcpProtocolVersion, '2026-07-28')
})
