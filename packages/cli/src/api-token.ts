import { loadStoredApiToken, type StoredApiToken } from './api-token-store.js'
import { apiTokenEnvVar, defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { type SecretBackend, type StoreResolution } from './store.js'

/** Mirrors `cliTokenLifetimeAliases` in auth-bootstrap (keep in sync; avoid import cycle). */
export type CliTokenLifetimeAlias = 'short' | 'long'

/** ADR 0056 `short` absolute max (24h), used only to infer hint lifetime. */
const shortAbsoluteLifetimeMs = 24 * 60 * 60 * 1000

/** Platform tracking for login OAuth as CapabilityProxy / package-graph Bearer. */
export const localExecuteOauthPlatformIssueUrl =
	'https://github.com/kody-hq/kody/issues/2812'

export type ResolveScopedApiTokenInput = {
	tokenValues?: { token?: string }
	env?: NodeJS.ProcessEnv
	apiUrl?: string
	apiTokenBackend?: SecretBackend
	apiTokenResolution?: StoreResolution
	/** Test seam. */
	loadApiToken?: typeof loadStoredApiToken
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function tryParseUrl(value: string): URL | null {
	try {
		return new URL(value)
	} catch {
		return null
	}
}

function isWorkersDevHostname(hostname: string): boolean {
	return hostname.endsWith('.workers.dev')
}

/** Whether a login OAuth bearer may be sent to this API origin. */
export function isPairedApiUrl(
	apiUrl: string = defaultApiUrl,
	mcpUrl: string = defaultMcpUrl,
): boolean {
	const api = tryParseUrl(apiUrl)
	const mcp = tryParseUrl(mcpUrl)
	if (!api || !mcp) return false

	const apiIsLoopback = loopbackHosts.has(api.hostname.toLowerCase())
	const mcpIsLoopback = loopbackHosts.has(mcp.hostname.toLowerCase())
	if (apiIsLoopback && mcpIsLoopback) {
		return (
			['http:', 'https:'].includes(api.protocol) &&
			['http:', 'https:'].includes(mcp.protocol)
		)
	}
	if (api.protocol !== 'https:' || mcp.protocol !== 'https:') return false
	const apiIsWorkersDev = isWorkersDevHostname(api.hostname)
	const mcpIsWorkersDev = isWorkersDevHostname(mcp.hostname)
	if (apiIsWorkersDev || mcpIsWorkersDev) {
		if (!apiIsWorkersDev || !mcpIsWorkersDev) return false
		const apiLabels = api.hostname.toLowerCase().split('.')
		const mcpLabels = mcp.hostname.toLowerCase().split('.')
		return (
			apiLabels.length === mcpLabels.length &&
			apiLabels.slice(1).join('.') === mcpLabels.slice(1).join('.') &&
			apiLabels[0] === `${mcpLabels[0]}-api`
		)
	}
	return api.hostname.toLowerCase() === `api.${mcp.hostname.toLowerCase()}`
}

export function expectedPairedApiOrigin(mcpUrl: string): string {
	const mcp = tryParseUrl(mcpUrl)
	if (!mcp) return 'a paired API origin'
	if (loopbackHosts.has(mcp.hostname.toLowerCase())) {
		return 'a loopback API origin'
	}
	const hostname = mcp.hostname.toLowerCase()
	if (isWorkersDevHostname(hostname)) {
		const labels = hostname.split('.')
		labels[0] = `${labels[0]}-api`
		return `https://${labels.join('.')}`
	}
	return `https://api.${hostname}`
}

/**
 * Scoped Open API / CapabilityProxy token (`kody_at_…`). Same source for
 * `execute --local`, token-only cloud execute, and Open API search/whoami.
 */
export function readApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const token = (values.token ?? env[apiTokenEnvVar] ?? '').trim()
	return token.length > 0 ? token : null
}

/**
 * Resolve a scoped API token without falling back to `kody login` OAuth.
 * Priority: `--token` / `KODY_API_TOKEN` → stored bootstrap/API token.
 */
export function resolveScopedApiToken(
	input: ResolveScopedApiTokenInput = {},
): string | null {
	const token = readApiToken(input.tokenValues, input.env)
	if (token) return token
	const apiUrl = input.apiUrl || defaultApiUrl
	const loadApi = input.loadApiToken ?? loadStoredApiToken
	return (
		loadApi(apiUrl, input.apiTokenBackend, input.apiTokenResolution)?.token ??
		null
	)
}

/** True when the bearer looks like a minted Open API token (not MCP OAuth). */
export function isScopedApiToken(token: string): boolean {
	return token.startsWith('kody_at_')
}

/**
 * How to mint a scoped token for CI/headless. Interactive agents on MCP should
 * prefer `cliCredentialBootstrap` → run returned `cli_command` instead.
 */
export function apiTokenMintInstructions(): string {
	return `For CI/headless only: mint with the Kody MCP \`api\` tool \`tokenCreate\` (include \`org:execute\` plus the capability scopes this command needs, e.g. \`package:execute\` / \`integration:read\`) and set ${apiTokenEnvVar} (prefer env over --token).`
}

/**
 * Shared guidance for every missing or invalid CLI auth failure. Agents hit
 * this wall; put the MCP bootstrap path first and never ask a human for a token.
 */
export function notAuthenticatedGuidance(
	lifetime: CliTokenLifetimeAlias = 'short',
): string {
	return (
		`If you are an agent connected to the Kody MCP server, call \`cliCredentialBootstrap\` ` +
		`(MCP \`execute\` with \`kody.cliCredentialBootstrap({ lifetime: "${lifetime}", scopes: [...] })\`, ` +
		`or MCP \`api\` with operationId \`cliCredentialBootstrap\`) and run the returned \`cli_command\`; ` +
		`never ask a human to paste a token. Humans: run \`kody login\`. ` +
		apiTokenMintInstructions()
	)
}

/**
 * One generic not-authenticated message for missing or invalid auth (all
 * commands). Optional `purpose` names the command that failed.
 */
export function notAuthenticatedMessage(
	purpose?: string,
	lifetime: CliTokenLifetimeAlias = 'short',
): string {
	const head = purpose ? `${purpose}: not authenticated.` : 'Not authenticated.'
	return `${head} ${notAuthenticatedGuidance(lifetime)}`
}

/**
 * 401 when a scoped `kody_at_…` was rejected. Same agent-first guidance as
 * missing auth (do not tell agents to ask a human for a fresh token).
 */
export function rejectedApiTokenMessage(detail = ''): string {
	return `Kody rejected the API token (expired, revoked, or malformed). ${notAuthenticatedGuidance()}${detail}`
}

/**
 * CapabilityProxy refused the token outright (not a missing scope): one line
 * saying so, then one line with the command that fixes it.
 */
export function capabilityProxyForbiddenMessage(input: {
	code: string | null
	serverMessage?: string | null
}): string {
	const reason = input.serverMessage ? `: ${input.serverMessage}` : ''
	return (
		`The API token is not allowed to use CapabilityProxy (${input.code ?? 'forbidden'})${reason}.\n` +
		`Fix: ${notAuthenticatedGuidance()}`
	)
}

/** Preferred interactive path for agents already on Kody MCP (ADR 0056). */
export function cliBootstrapInstructions(
	lifetime: CliTokenLifetimeAlias = 'short',
): string {
	return (
		`call \`cliCredentialBootstrap\` (MCP \`execute\` with \`kody.cliCredentialBootstrap({ lifetime: "${lifetime}", scopes: [...] })\`, ` +
		`or MCP \`api\` with operationId \`cliCredentialBootstrap\`) and run the returned \`cli_command\``
	)
}

/**
 * Infer short|long from a stored token's absolute expiry. Tokens that can live
 * longer than the `short` absolute max are treated as `long` so
 * `insufficient_scope` hints remint with the same lifetime class.
 */
export function inferCliTokenLifetimeAlias(
	stored: Pick<StoredApiToken, 'expiresAt' | 'maxExpiresAt'> | null | undefined,
	nowMs: number = Date.now(),
): CliTokenLifetimeAlias {
	if (!stored) return 'short'
	const absoluteMs =
		Date.parse(stored.maxExpiresAt ?? '') || Date.parse(stored.expiresAt ?? '')
	if (!Number.isFinite(absoluteMs)) return 'short'
	return absoluteMs - nowMs > shortAbsoluteLifetimeMs ? 'long' : 'short'
}

/** `--lifetime short|long` fragment for auth bootstrap hint commands. */
export function cliBootstrapLifetimeFlags(
	lifetime: CliTokenLifetimeAlias = 'short',
): string {
	return `--lifetime ${lifetime}`
}

/** `{ lifetime: "short"|"long" }` for cliCredentialBootstrap hint calls. */
export function cliBootstrapLifetimeMintFields(
	lifetime: CliTokenLifetimeAlias = 'short',
): Record<string, string | number> {
	return { lifetime }
}

/** Lifetime hint from the stored API token for `apiUrl`, defaulting to short. */
export function currentStoredTokenLifetimeAlias(
	apiUrl: string = defaultApiUrl,
	nowMs: number = Date.now(),
	loadApiToken: typeof loadStoredApiToken = loadStoredApiToken,
): CliTokenLifetimeAlias {
	return inferCliTokenLifetimeAlias(loadApiToken(apiUrl), nowMs)
}

/** Alias of {@link notAuthenticatedMessage} (token-only command paths). */
export function missingApiTokenMessage(purpose: string): string {
	return notAuthenticatedMessage(purpose)
}

/** Alias of {@link notAuthenticatedMessage} (`execute --local` paths). */
export function missingLocalExecuteAuthMessage(
	purpose: string = 'execute --local',
): string {
	return notAuthenticatedMessage(purpose)
}

/** Alias of {@link notAuthenticatedMessage} (login/session paths). */
export function missingCliAuthMessage(): string {
	return notAuthenticatedMessage()
}

/** 401 when CapabilityProxy rejected a non-`kody_at_` bearer (typically CLI OAuth). */
export function rejectedOauthBearerMessage(): string {
	return (
		`Kody rejected the bearer from \`kody login\`: the Open API still accepts only scoped \`kody_at_…\` API tokens on CapabilityProxy / package-graph (not MCP OAuth). ` +
		`See ${localExecuteOauthPlatformIssueUrl}. Until that lands, ${notAuthenticatedGuidance()}`
	)
}

/** What an `insufficient_scope` error body says about the missing scope. */
export type InsufficientScopeDetails = {
	requiredScope: string | null
	/** Full scope list for a replacement token (the caller's scopes plus the missing one). */
	mintScopes: Array<string> | null
	/** Platform denial code, e.g. `credential_scope` or `missing_permission`. */
	denial: string | null
}

export function readInsufficientScopeDetails(
	body: unknown,
): InsufficientScopeDetails {
	const details =
		isRecord(body) && isRecord(body.error) && isRecord(body.error.details)
			? body.error.details
			: null
	if (!details) return { requiredScope: null, mintScopes: null, denial: null }
	const requiredScope =
		readNonEmptyString(details.required_scope) ??
		readNonEmptyString(details.required_permission) ??
		readStringList(details.required_scopes)?.join(', ') ??
		null
	return {
		requiredScope,
		mintScopes: readStringList(details.mint_scopes),
		denial: readNonEmptyString(details.denial),
	}
}

/** `npx @kodycodes/cli auth bootstrap --lifetime short --scopes a,b` */
export function cliBootstrapScopesCommand(
	scopes: ReadonlyArray<string>,
	lifetimeFlags: string | CliTokenLifetimeAlias = 'short',
): string {
	const flags =
		lifetimeFlags === 'short' || lifetimeFlags === 'long'
			? cliBootstrapLifetimeFlags(lifetimeFlags)
			: lifetimeFlags
	return `npx @kodycodes/cli auth bootstrap ${flags} --scopes ${scopes.join(',')}`
}

/** `cliCredentialBootstrap({ lifetime: "short", scopes: ["a", "b"] })` */
export function cliBootstrapMintCall(
	scopes: ReadonlyArray<string>,
	lifetime: Record<string, string | number> | CliTokenLifetimeAlias = 'short',
): string {
	const fieldsRecord =
		lifetime === 'short' || lifetime === 'long'
			? cliBootstrapLifetimeMintFields(lifetime)
			: lifetime
	const fields = [
		...Object.entries(fieldsRecord).map(
			([key, value]) => `${key}: ${JSON.stringify(value)}`,
		),
		`scopes: [${scopes.map((scope) => JSON.stringify(scope)).join(', ')}]`,
	]
	return `cliCredentialBootstrap({ ${fields.join(', ')} })`
}

export function insufficientScopeMessage(
	input: Partial<InsufficientScopeDetails> & {
		/** Scopes the CLI already knows the current token holds. */
		currentScopes?: ReadonlyArray<string> | null
		/**
		 * Lifetime class to preserve in remint hints. Defaults to `short` only
		 * when unknown — pass the current token's inferred alias when available.
		 */
		currentLifetime?: CliTokenLifetimeAlias | null
	},
): string {
	const required = input.requiredScope ?? null
	const lifetime: CliTokenLifetimeAlias =
		input.currentLifetime === 'long' || input.currentLifetime === 'short'
			? input.currentLifetime
			: 'short'
	const lifetimeFlags = cliBootstrapLifetimeFlags(lifetime)
	const lifetimeMint = cliBootstrapLifetimeMintFields(lifetime)
	if (input.denial === 'missing_permission') {
		return `Kody returned insufficient_scope: your org role does not grant ${
			required ? `"${required}"` : 'the required permission'
		}. A new token cannot add it; an org Owner can grant it.`
	}
	if (!required) {
		return `Kody returned insufficient_scope. Mint a token that includes the missing scope: run \`${cliBootstrapScopesCommand(['<scope>', '…'], lifetimeFlags)}\` after \`kody login\`, or from Kody MCP call \`${cliBootstrapMintCall(['<scope>', '…'], lifetimeMint)}\` and run its cli_command. Scopes replace the defaults, so list every scope you need. For CI/headless, mint with tokenCreate and pass --token or set ${apiTokenEnvVar}.`
	}
	const mintScopes =
		input.mintScopes && input.mintScopes.length > 0
			? input.mintScopes
			: input.currentScopes && input.currentScopes.length > 0
				? [
						...new Set([...input.currentScopes, ...required.split(/,\s*/)]),
					].sort()
				: null
	if (!mintScopes) {
		return `Kody returned insufficient_scope: this token is missing "${required}". Mint a token whose scopes include "${required}" plus the ones you already use (scopes replace the defaults): run \`${cliBootstrapScopesCommand(['<current scopes>', required], lifetimeFlags)}\` after \`kody login\`, or from Kody MCP call \`${cliBootstrapMintCall(['<current scopes>', required], lifetimeMint)}\` and run its cli_command. For CI/headless, mint with tokenCreate including "${required}" and pass --token or set ${apiTokenEnvVar}.`
	}
	return `Kody returned insufficient_scope: this token is missing "${required}". Mint one that includes it: run \`${cliBootstrapScopesCommand(mintScopes, lifetimeFlags)}\` after \`kody login\`, or from Kody MCP call \`${cliBootstrapMintCall(mintScopes, lifetimeMint)}\` and run its cli_command. For CI/headless, mint with tokenCreate using those scopes and pass --token or set ${apiTokenEnvVar}.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStringList(value: unknown): Array<string> | null {
	if (!Array.isArray(value)) return null
	const list = value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter(Boolean)
	return list.length > 0 ? list : null
}

export function featureDisabledMessage(): string {
	return 'Kody returned feature_disabled: CapabilityProxy is not enabled for this Kody account (feature flag `local-execute`). `execute --local` and token-auth cloud execute both stop here; minting another token does not bypass the flag. Browser `kody login` can still run cloud execute over MCP.'
}

export function requireApiToken(
	values: { token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
	purpose: string = 'this command',
	options: Omit<ResolveScopedApiTokenInput, 'tokenValues' | 'env'> = {},
): string {
	const token = resolveScopedApiToken({
		tokenValues: values,
		env,
		...options,
	})
	if (!token) throw new Error(notAuthenticatedMessage(purpose))
	return token
}

/** True when the user passed `--token` (not only the env var). */
export function hasExplicitTokenFlag(values: { token?: string }): boolean {
	return typeof values.token === 'string' && values.token.trim().length > 0
}
