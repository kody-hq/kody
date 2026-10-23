import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadStoredApiToken } from '../src/api-token-store.js'
import { runCli } from '../src/cli.js'
import { setupGitDefaultScopes } from '../src/setup-git.js'
import {
	createFileBackend,
	fileStorePath,
	saveCredentials,
} from '../src/store.js'

const apiUrl = 'https://api.setup-git-login-cli.test'
const mcpUrl = 'https://login-setup-git.test/mcp'
const mintedCode = `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`
const redeemedToken = `kody_at_${'r'.repeat(20)}_${'S'.repeat(43)}`

type Recorded = { url: string; authorization: string | null; body: unknown }

const openApiDocument = {
	paths: {
		'/v1/tokens/bootstrap': { post: { operationId: 'cliCredentialBootstrap' } },
		'/v1/tokens/current': { get: { operationId: 'tokenGetCurrent' } },
	},
}

function mintResponse(scopes: ReadonlyArray<string>) {
	return {
		bootstrap_code: mintedCode,
		expires_at: '2026-10-13T20:00:00.000Z',
		cli_command: `npx @kodycodes/cli auth bootstrap --code ${mintedCode} --lifetime long`,
		name: 'kody-cli-bootstrap',
		scopes: [...scopes],
		idle_ttl_seconds: 1_209_600,
		max_lifetime_seconds: 7_776_000,
	}
}

const redeemResponse = {
	token: redeemedToken,
	token_type: 'Bearer',
	id: 'tok_setup_git_login',
	name: 'kody-cli-bootstrap',
	scopes: [...setupGitDefaultScopes],
	status: 'active',
	idle_ttl_seconds: 1_209_600,
	expires_at: '2026-10-27T19:00:00.000Z',
	max_expires_at: '2027-01-11T19:00:00.000Z',
	created_via: 'cli-bootstrap',
	org_binding: 'user',
}

async function withCliEnv<T>(
	fetchStub: (
		url: string,
		init: RequestInit | undefined,
	) => Promise<Response> | Response,
	run: (ctx: { home: string; requests: Array<Recorded> }) => Promise<T>,
): Promise<T> {
	const home = mkdtempSync(join(tmpdir(), 'kody-cli-setup-git-login-'))
	const saved = {
		HOME: process.env.HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		KODY_API_TOKEN: process.env.KODY_API_TOKEN,
		KODY_MCP_URL: process.env.KODY_MCP_URL,
		KODY_API_URL: process.env.KODY_API_URL,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
	}
	process.env.HOME = home
	process.env.XDG_CONFIG_HOME = home
	process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig')
	process.env.GIT_CONFIG_SYSTEM = '/dev/null'
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
	try {
		return await run({ home, requests })
	} finally {
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

function saveLogin(url: string) {
	saveCredentials(
		{
			version: 1,
			mcpUrl: url,
			org: 'test-org',
			resource: url,
			authorizationServerUrl: new URL(url).origin,
			clientId: 'client-1',
			accessToken: 'kody_at_login_session',
			tokenType: 'bearer',
			expiresAt: Date.now() + 120_000,
			scope: 'org:execute package:write',
		},
		createFileBackend(fileStorePath(url)),
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

test('auth setup-git after kody login (no env token) mints via Open API and installs helper', async () => {
	await withCliEnv(
		(url) => {
			if (requestPath(url).endsWith('/openapi.json'))
				return json(openApiDocument)
			if (requestPath(url).endsWith('/v1/tokens/bootstrap'))
				return json(mintResponse(setupGitDefaultScopes))
			if (requestPath(url).endsWith('/v1/tokens/bootstrap/redeem'))
				return json(redeemResponse)
			if (url.includes('/v1/tokens/current')) {
				return json({
					id: 'tok_setup_git_login',
					org_binding: 'user',
					scopes: [...setupGitDefaultScopes],
					expires_at: redeemResponse.expires_at,
				})
			}
			return json({ error: { code: 'not_found', message: url } }, 404)
		},
		async ({ home, requests }) => {
			saveLogin(mcpUrl)
			assert.equal(process.env.KODY_API_TOKEN, undefined)
			assert.equal(loadStoredApiToken(apiUrl), null)

			const result = await capture([
				'auth',
				'setup-git',
				'--mcp-url',
				mcpUrl,
				'--api-url',
				apiUrl,
			])
			assert.equal(result.code, 0, result.stderr || result.stdout)
			assert.match(result.stdout, /Git HTTPS credential helper installed/)
			assert.match(
				result.stdout,
				/token: minted tok_setup_git_login \(org_binding=user\)/,
			)
			assert.match(result.stdout, /all orgs/)
			assert.doesNotMatch(result.stdout, /kody_at_|kody_bc_/)

			const mint = requests.find((request) =>
				requestPath(request.url).endsWith('/v1/tokens/bootstrap'),
			)
			assert.equal(mint?.authorization, 'Bearer kody_at_login_session')
			assert.deepEqual(mint?.body, {
				scopes: [...setupGitDefaultScopes],
				lifetime: 'long',
			})
			assert.equal(loadStoredApiToken(apiUrl)?.tokenId, 'tok_setup_git_login')

			const gitconfig = readFileSync(join(home, 'gitconfig'), 'utf8')
			assert.match(gitconfig, /https:\/\/login-setup-git\.test/)
			assert.match(gitconfig, /git-credential/)
			assert.match(gitconfig, /useHttpPath|usehttppath/i)
		},
	)
})
