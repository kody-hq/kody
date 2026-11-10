import { createInterface } from 'node:readline'
import { isScopedApiToken } from './api-token.js'
import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { ensureOpenApiCredentials } from './auth.js'
import { apiTokenNeedsRefresh, gitCredentialHostFromMcpUrl } from './setup-git.js'
import {
	loadCredentials,
	type SecretBackend,
	type StoreResolution,
} from './store.js'

export type GitCredentialAction = 'get' | 'store' | 'erase'

export type GitCredentialRequest = {
	protocol?: string
	host?: string
	path?: string
	username?: string
	password?: string
}

/**
 * Parse git credential helper stdin (`key=value` lines, blank line ends).
 * See `git help credential`.
 */
export function parseGitCredentialInput(text: string): GitCredentialRequest {
	const out: GitCredentialRequest = {}
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue
		const eq = line.indexOf('=')
		if (eq <= 0) continue
		const key = line.slice(0, eq)
		const value = line.slice(eq + 1)
		switch (key) {
			case 'protocol':
			case 'host':
			case 'path':
			case 'username':
			case 'password':
				out[key] = value
				break
			default:
				break
		}
	}
	return out
}

export function formatGitCredentialOutput(input: {
	username: string
	password: string
}): string {
	return `username=${input.username}\npassword=${input.password}\n`
}

export function isKodyGitHttpsHost(input: {
	protocol?: string
	host?: string
	expectedHost: string
}): boolean {
	if (input.protocol && input.protocol !== 'https') return false
	if (!input.host) return false
	return input.host.toLowerCase() === input.expectedHost.toLowerCase()
}

export type EnsureGitApiTokenResult = {
	token: string
	refreshed: boolean
}

/**
 * The bearer git HTTPS sends: `KODY_API_TOKEN`, else the one saved CLI
 * credential (`kody login` / `kody auth bootstrap`). No network while the
 * saved token is still valid; otherwise refresh it the way every other
 * command does. Never mints a separate token.
 */
export async function ensureGitApiToken(input: {
	apiUrl?: string
	mcpUrl?: string
	nowMs?: number
	env?: NodeJS.ProcessEnv
	backend?: SecretBackend
	resolution?: StoreResolution
	loadLogin?: typeof loadCredentials
	refresh?: typeof ensureOpenApiCredentials
}): Promise<EnsureGitApiTokenResult | null> {
	const envToken = (input.env ?? process.env)[apiTokenEnvVar]?.trim()
	if (envToken) return { token: envToken, refreshed: false }
	const mcpUrl = input.mcpUrl || defaultMcpUrl
	const saved = (input.loadLogin ?? loadCredentials)(
		mcpUrl,
		input.backend,
		input.resolution,
	)
	if (!saved) return null
	const nowMs = input.nowMs ?? Date.now()
	if (
		isScopedApiToken(saved.accessToken) &&
		!apiTokenNeedsRefresh(
			{
				expiresAt:
					saved.expiresAt === undefined
						? null
						: new Date(saved.expiresAt).toISOString(),
			},
			nowMs,
		)
	) {
		return { token: saved.accessToken, refreshed: false }
	}
	try {
		const fresh = await (input.refresh ?? ensureOpenApiCredentials)({
			mcpUrl,
			apiUrl: input.apiUrl || defaultApiUrl,
			backend: input.backend,
			resolution: input.resolution,
			now: nowMs,
		})
		return { token: fresh.accessToken, refreshed: true }
	} catch {
		// Stay silent on the git credential protocol (stdout). A transient
		// refresh failure keeps the saved token, which may still work.
		return isScopedApiToken(saved.accessToken)
			? { token: saved.accessToken, refreshed: false }
			: null
	}
}

/**
 * Handle one git credential helper action.
 * - `get`: return the saved CLI credential's `kody_at_…` for the configured
 *   Kody HTTPS host (refreshed like any command when near expiry)
 * - `store` / `erase`: no-op (credential life is managed by login / logout)
 */
export async function handleGitCredential(input: {
	action: GitCredentialAction
	request: GitCredentialRequest
	apiUrl?: string
	mcpUrl?: string
	backend?: SecretBackend
	resolution?: StoreResolution
	nowMs?: number
	env?: NodeJS.ProcessEnv
	loadLogin?: typeof loadCredentials
	refresh?: typeof ensureOpenApiCredentials
}): Promise<string> {
	if (input.action === 'store' || input.action === 'erase') {
		return ''
	}
	if (input.action !== 'get') {
		throw new Error(`Unknown git-credential action "${String(input.action)}".`)
	}

	const expectedHost = gitCredentialHostFromMcpUrl(
		input.mcpUrl || defaultMcpUrl,
	)
	if (
		!isKodyGitHttpsHost({
			protocol: input.request.protocol,
			host: input.request.host,
			expectedHost,
		})
	) {
		return ''
	}

	const ensured = await ensureGitApiToken({
		apiUrl: input.apiUrl,
		mcpUrl: input.mcpUrl,
		backend: input.backend,
		resolution: input.resolution,
		nowMs: input.nowMs,
		...(input.env ? { env: input.env } : {}),
		...(input.loadLogin ? { loadLogin: input.loadLogin } : {}),
		...(input.refresh ? { refresh: input.refresh } : {}),
	})
	if (!ensured?.token) {
		return ''
	}

	return formatGitCredentialOutput({
		username: 'x',
		password: ensured.token,
	})
}

export function parseGitCredentialAction(
	argv: ReadonlyArray<string>,
): GitCredentialAction {
	const action = argv[0]
	if (action === 'get' || action === 'store' || action === 'erase')
		return action
	throw new Error(
		'Usage: kody git-credential <get|store|erase>\n(Git invokes this as a credential helper; see `kody auth setup-git`.)',
	)
}

/** Read stdin until EOF (git closes after the attribute block). */
export async function readGitCredentialStdin(
	stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	if ('isTTY' in stdin && stdin.isTTY) return ''
	const chunks: Array<string> = []
	const rl = createInterface({ input: stdin, crlfDelay: Infinity })
	for await (const line of rl) {
		chunks.push(line)
	}
	return chunks.join('\n')
}
