import { loadStoredApiToken, type StoredApiToken } from './api-token-store.js'
import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl } from './defaults.js'
import {
	loadCredentials,
	type SecretBackend,
	type StoreResolution,
	type StoredCredentials,
} from './store.js'

/**
 * Where a command's bearer comes from:
 * - `token-flag`: `--token`
 * - `env`: `KODY_API_TOKEN`
 * - `stored-api-token`: the token `kody auth bootstrap` / `kody auth setup-git` stored
 * - `login`: the `kody login` session
 */
export type CliCredentialSource =
	| 'token-flag'
	| 'env'
	| 'stored-api-token'
	| 'login'

/**
 * Precedence by purpose (one resolver for every command):
 * - `call` (api, package, execute --local, context, daemon, dev, whoami):
 *   `--token`, `KODY_API_TOKEN`, stored API token, `kody login`.
 * - `session` (search, cloud execute): `--token`, `kody login`,
 *   `KODY_API_TOKEN`, stored API token. Kept for compatibility: these
 *   commands run over MCP with a login, so a leftover token does not switch
 *   them to the Open API path.
 * - `mint` (`auth bootstrap --scopes`): `--token`, `kody login`,
 *   `KODY_API_TOKEN`, stored API token. A login can mint any scope the org
 *   role grants; a token only the scopes it holds.
 */
export type CliCredentialPurpose = 'call' | 'session' | 'mint'

const precedence: Record<
	CliCredentialPurpose,
	ReadonlyArray<CliCredentialSource>
> = {
	call: ['token-flag', 'env', 'stored-api-token', 'login'],
	session: ['token-flag', 'login', 'env', 'stored-api-token'],
	mint: ['token-flag', 'login', 'env', 'stored-api-token'],
}

export type CliCredentialCandidate = {
	source: CliCredentialSource
	/** Bearer for token sources; `login` resolves its bearer when used. */
	token: string | null
	/** Stored API token metadata (`stored-api-token` only). */
	stored?: StoredApiToken
	/** Login session (`login` only). */
	login?: StoredCredentials
}

export type CliCredential = CliCredentialCandidate & {
	purpose: CliCredentialPurpose
	/** Other credentials that exist but lose to this one, in precedence order. */
	shadowed: Array<CliCredentialCandidate>
}

export type ResolveCliCredentialInput = {
	tokenValues?: { token?: string }
	env?: NodeJS.ProcessEnv
	apiUrl?: string
	mcpUrl?: string
	/** When set, only a login for this org counts. */
	org?: string
	purpose?: CliCredentialPurpose
	apiTokenBackend?: SecretBackend
	apiTokenResolution?: StoreResolution
	loginBackend?: SecretBackend
	/** Test seams. */
	loadApiToken?: typeof loadStoredApiToken
	loadLogin?: (mcpUrl: string, org?: string) => StoredCredentials | null
}

type Loaded = { candidate: CliCredentialCandidate | null; error?: unknown }

function loadCandidate(
	source: CliCredentialSource,
	input: ResolveCliCredentialInput,
): Loaded {
	try {
		if (source === 'token-flag') {
			const flag = input.tokenValues?.token?.trim()
			return { candidate: flag ? { source, token: flag } : null }
		}
		if (source === 'env') {
			const value = (input.env ?? process.env)[apiTokenEnvVar]?.trim()
			return { candidate: value ? { source, token: value } : null }
		}
		if (source === 'stored-api-token') {
			const load = input.loadApiToken ?? loadStoredApiToken
			const stored = load(
				input.apiUrl || defaultApiUrl,
				input.apiTokenBackend,
				input.apiTokenResolution,
			)
			return {
				candidate: stored ? { source, token: stored.token, stored } : null,
			}
		}
		const mcpUrl = input.mcpUrl || defaultMcpUrl
		const login = input.loadLogin
			? input.loadLogin(mcpUrl, input.org)
			: loadCredentials(mcpUrl, input.loginBackend, undefined, {
					org: input.org,
				})
		return { candidate: login ? { source, token: null, login } : null }
	} catch (error) {
		return { candidate: null, error }
	}
}

let activeCredential: CliCredential | null = null

/**
 * Pick the credential a command uses. Every command goes through this, so
 * `kody whoami` reports the same credential `kody api` and the others send.
 * Returns null when nothing is stored (callers print the not-authenticated
 * guidance). The pick is remembered for error messages in this process.
 */
export function resolveCliCredential(
	input: ResolveCliCredentialInput = {},
): CliCredential | null {
	const purpose = input.purpose ?? 'call'
	// Desktop explicitly opts into its browser login without changing any saved
	// API tokens used by terminal commands or other clients.
	const source = (input.env ?? process.env).KODY_CREDENTIAL_SOURCE
	if (source && source !== 'login')
		throw new Error('KODY_CREDENTIAL_SOURCE must be login when set.')
	let picked: CliCredentialCandidate | null = null
	const shadowed: Array<CliCredentialCandidate> = []
	for (const candidateSource of source === 'login'
		? ['login' as const]
		: precedence[purpose]) {
		const loaded = loadCandidate(candidateSource, input)
		// An unreadable store only fails the command when it would be used.
		if (loaded.error !== undefined && !picked) throw loaded.error
		if (!loaded.candidate) continue
		if (picked) shadowed.push(loaded.candidate)
		else picked = loaded.candidate
	}
	if (!picked) return null
	const credential = { ...picked, purpose, shadowed }
	activeCredential = credential
	return credential
}

/** The credential the current command resolved last, if any. */
export function activeCliCredential(): CliCredential | null {
	return activeCredential
}

/** Forget the remembered pick (start of each `runCli`). */
export function resetActiveCliCredential(): void {
	activeCredential = null
}

/** Remember a login bearer resolved after the fact (ensureOpenApiCredentials). */
export function noteActiveLoginCredential(input: {
	login: StoredCredentials
	purpose?: CliCredentialPurpose
}): void {
	if (activeCredential?.source === 'login') {
		activeCredential = { ...activeCredential, login: input.login }
		return
	}
	activeCredential = {
		source: 'login',
		token: null,
		login: input.login,
		purpose: input.purpose ?? 'call',
		shadowed: [],
	}
}

/** Short human label, e.g. "stored API token tok_123 (from kody auth bootstrap)". */
export function describeCliCredential(
	candidate: CliCredentialCandidate,
): string {
	switch (candidate.source) {
		case 'token-flag':
			return '--token'
		case 'env':
			return apiTokenEnvVar
		case 'stored-api-token': {
			const via = storedTokenOrigin(candidate.stored)
			return `stored API token ${candidate.stored?.tokenId ?? ''}`.trim() + via
		}
		case 'login':
			return candidate.login?.org
				? `kody login session (org ${candidate.login.org})`
				: 'kody login session'
	}
}

function storedTokenOrigin(stored: StoredApiToken | undefined): string {
	if (!stored?.createdVia) return ' (from kody auth bootstrap or setup-git)'
	return stored.createdVia === 'cli-bootstrap'
		? ' (from kody auth bootstrap)'
		: ` (created via ${stored.createdVia})`
}

/** Commands that use the credential each purpose picks (for whoami/login notices). */
export const callPurposeCommands =
	'api, package, execute --local, context, daemon, and dev'
export const sessionPurposeCommands = 'search and cloud execute'

/** `npx @kodycodes/cli auth bootstrap …` hint that replaces a stored token. */
export function replaceStoredTokenCommand(
	scopes: ReadonlyArray<string> | null | undefined,
	lifetime: 'short' | 'long' = 'short',
): string {
	const list = scopes && scopes.length > 0 ? scopes.join(',') : '<scopes>'
	return `npx @kodycodes/cli auth bootstrap --lifetime ${lifetime} --scopes ${list}`
}

/**
 * Sentence for insufficient_scope errors naming the credential that was sent
 * (null when none was resolved in this process).
 */
export function credentialUsedNote(input: {
	credential: CliCredential | null
	mintScopes: ReadonlyArray<string> | null
	lifetime: 'short' | 'long'
}): string | null {
	const { credential } = input
	if (!credential) return null
	const used = `Credential used: ${describeCliCredential(credential)}.`
	const fix = replaceStoredTokenCommand(
		input.mintScopes ?? ['<current scopes>', '<missing scope>'],
		input.lifetime,
	)
	if (
		credential.source === 'stored-api-token' &&
		credential.purpose === 'session'
	) {
		return `${used} Run \`kody login\` (search and cloud execute then use the login session before the stored token), or replace the stored token with \`${fix}\`.`
	}
	if (credential.source === 'stored-api-token') {
		return `${used} \`kody login\` does not replace a stored API token, so logging in again will not fix this. Replace the stored token with \`${fix}\`.`
	}
	if (credential.source === 'env' || credential.source === 'token-flag') {
		return `${used} It wins over any stored API token and \`kody login\` session; mint a token with the missing scope (tokenCreate) and update ${credential.source === 'env' ? 'KODY_API_TOKEN' : '--token'}, or unset it to fall back to the stored token or login.`
	}
	const stored = credential.shadowed.find(
		(other) => other.source === 'stored-api-token',
	)
	return stored
		? `${used} Your org role must grant the scope. (Also stored: ${describeCliCredential(stored)}.)`
		: `${used} Your org role must grant the scope; run \`kody login\` again if it was granted recently.`
}
