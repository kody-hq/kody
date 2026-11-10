import { deleteStoredApiToken, loadStoredApiToken } from './api-token-store.js'
import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl } from './defaults.js'
import {
	loadCredentials,
	saveCredentials,
	type SecretBackend,
	type StoreResolution,
	type StoredCredentials,
} from './store.js'

/**
 * Where a command's bearer comes from:
 * - `token-flag`: `--token`
 * - `env`: `KODY_API_TOKEN`
 * - `login`: the one saved CLI credential (`kody login` or `kody auth bootstrap`)
 */
type CliCredentialSource = 'token-flag' | 'env' | 'login'

/**
 * What the command does with the credential (for messages). Every purpose
 * uses the same precedence: `--token`, `KODY_API_TOKEN`, the saved credential.
 */
export type CliCredentialPurpose = 'call' | 'session' | 'mint'

const precedence: ReadonlyArray<CliCredentialSource> = [
	'token-flag',
	'env',
	'login',
]

export type CliCredentialCandidate = {
	source: CliCredentialSource
	/** Bearer for token sources; `login` resolves its bearer when used. */
	token: string | null
	/** Saved credential (`login` only). */
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
	/** Test seams. `loadApiToken` reads the pre-unification token slot. */
	loadApiToken?: typeof loadStoredApiToken
	saveLogin?: typeof saveCredentials
	deleteApiToken?: typeof deleteStoredApiToken
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
		const mcpUrl = input.mcpUrl || defaultMcpUrl
		const login = input.loadLogin
			? input.loadLogin(mcpUrl, input.org)
			: loadCredentials(mcpUrl, input.loginBackend, undefined, {
					org: input.org,
				})
		// Desktop (`KODY_CREDENTIAL_SOURCE=login`) never touches the old slot.
		const desktop =
			(input.env ?? process.env).KODY_CREDENTIAL_SOURCE === 'login'
		const saved =
			login ?? (desktop ? null : adoptLegacyStoredApiToken(input, mcpUrl))
		return { candidate: saved ? { source, token: null, login: saved } : null }
	} catch (error) {
		return { candidate: null, error }
	}
}

/**
 * Move a token from the slot `auth bootstrap` / `setup-git` used before the
 * CLI had one saved credential into that credential, then clear the old
 * slot. Only runs when nothing is saved: the saved credential always wins.
 */
function adoptLegacyStoredApiToken(
	input: ResolveCliCredentialInput,
	mcpUrl: string,
): StoredCredentials | null {
	const apiUrl = input.apiUrl || defaultApiUrl
	const legacy = (input.loadApiToken ?? loadStoredApiToken)(
		apiUrl,
		input.apiTokenBackend,
		input.apiTokenResolution,
	)
	if (!legacy) return null
	const adopted = storedCredentialsFromApiToken({
		mcpUrl,
		token: legacy.token,
		expiresAt: legacy.expiresAt ? Date.parse(legacy.expiresAt) : undefined,
		scopes: legacy.scopes ?? [],
		apiUrl,
	})
	try {
		;(input.saveLogin ?? saveCredentials)(adopted, input.loginBackend)
		;(input.deleteApiToken ?? deleteStoredApiToken)(
			apiUrl,
			input.apiTokenBackend,
			input.apiTokenResolution,
		)
	} catch {
		// Still usable for this command even if the move did not stick.
	}
	return adopted
}

/** A `kody_at_…` saved the way `kody login` saves its device token. */
export function storedCredentialsFromApiToken(input: {
	mcpUrl: string
	token: string
	expiresAt: number | undefined
	scopes: ReadonlyArray<string>
	org?: string
	apiUrl?: string
}): StoredCredentials {
	const issuer = new URL(input.mcpUrl).origin
	return {
		version: 1,
		mcpUrl: input.mcpUrl,
		...(input.org ? { org: input.org } : {}),
		resource: input.mcpUrl,
		authorizationServerUrl: issuer,
		clientId: new URL('/oauth/cli-client-metadata.json', issuer).href,
		accessToken: input.token,
		tokenType: 'bearer',
		...(input.expiresAt !== undefined && Number.isFinite(input.expiresAt)
			? { expiresAt: input.expiresAt }
			: {}),
		scope: input.scopes.join(' '),
		...(input.apiUrl ? { apiUrl: new URL(input.apiUrl).origin } : {}),
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
		: precedence) {
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

/** Short human label, e.g. "saved CLI credential (org acme)". */
export function describeCliCredential(
	candidate: CliCredentialCandidate,
): string {
	switch (candidate.source) {
		case 'token-flag':
			return '--token'
		case 'env':
			return apiTokenEnvVar
		case 'login':
			return candidate.login?.org
				? `saved CLI credential (org ${candidate.login.org})`
				: 'saved CLI credential'
	}
}

/** Commands that use the resolved credential (for whoami/login notices). */
export const callPurposeCommands =
	'api, package, execute --local, context, daemon, dev, search, cloud execute, and git'
export const sessionPurposeCommands = callPurposeCommands

const resignInHint =
	'Run `kody login` (agents on Kody MCP: call cliCredentialBootstrap with no scopes and run the returned cli_command) to save a credential with every scope your org role allows.'

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
	if (credential.source === 'env' || credential.source === 'token-flag') {
		return `${used} It wins over the saved CLI credential; mint a token with the missing scope (tokenCreate) and update ${credential.source === 'env' ? apiTokenEnvVar : '--token'}, or unset it to use the saved credential.`
	}
	return `${used} Your org role must grant the scope. If this credential was minted with a narrower --scopes list, ${resignInHint}`
}

/**
 * Sentence for 401 / rejected-token errors naming the credential that was sent
 * and the matching reauth path (null when none was resolved in this process).
 * Does not clear or switch credentials — only explains which source won.
 */
export function credentialRejectedNote(input: {
	credential: CliCredential | null
	lifetime?: 'short' | 'long'
}): string | null {
	const { credential } = input
	if (!credential) return null
	const used = `Credential used: ${describeCliCredential(credential)}.`
	if (credential.source === 'token-flag' || credential.source === 'env') {
		const name = credential.source === 'env' ? apiTokenEnvVar : '--token'
		return `${used} ${name} wins over the saved CLI credential; unset or replace ${name} before retrying, or mint a fresh token (agents: cliCredentialBootstrap then run the returned cli_command; CI: tokenCreate) and update that value. Humans: \`kody login\` saves a fresh credential.`
	}
	return `${used} ${resignInHint}`
}
