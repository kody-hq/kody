import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
	apiTokenEnvVar,
	cliName,
	defaultApiUrl,
	defaultMcpUrl,
} from './defaults.js'
import {
	authBootstrapWithScopes,
	cliTokenLifetimeAliases,
	resolveCliTokenLifetime,
	type ResolvedCliTokenLifetime,
} from './auth-bootstrap.js'
import {
	deleteStoredApiToken,
	loadStoredApiToken,
	type StoredApiToken,
} from './api-token-store.js'
import { OpenApiError, openApiGet, openApiRequest } from './open-api-client.js'
import { type SecretBackend, type StoreResolution } from './store.js'
import { which as whichOnPath } from './which.js'

/** Scopes setup-git always requires for clone/fetch (+ push). */
export const setupGitRequiredScopes = ['package:read', 'package:write'] as const

/**
 * Default mint list when setup-git needs a fresh token: CLI bootstrap defaults
 * plus the package scopes git HTTPS needs. Callers can replace via `--scopes`.
 */
export const setupGitDefaultScopes: ReadonlyArray<string> = [
	'app:execute',
	'app:read',
	'email:read',
	'email:send',
	'integration:read',
	'integration:use',
	'job:execute',
	'job:read',
	'memory:read',
	'org:execute',
	'org:read',
	'package:execute',
	'package:read',
	'package:write',
	'secret:use',
	'token:delete',
]

export type TokenCurrentMetadata = {
	id: string
	orgBinding: 'org' | 'user' | null
	scopes: Array<string>
	expiresAt: string | null
}

/**
 * Origin host for `credential.https://<host>.*` (guide: `kody.codes`).
 * Derived from the MCP URL origin so preview / self-host installs match.
 */
export function gitCredentialHostFromMcpUrl(
	mcpUrl: string = defaultMcpUrl,
): string {
	return new URL(mcpUrl).host
}

export function scopesIncludeRequired(
	scopes: ReadonlyArray<string> | null | undefined,
	required: ReadonlyArray<string> = setupGitRequiredScopes,
): boolean {
	if (!scopes) return false
	const held = new Set(scopes)
	return required.every((scope) => held.has(scope))
}

/** Ensure package:read/write are present; preserve order of the base list. */
export function ensureSetupGitScopes(
	base: ReadonlyArray<string> = setupGitDefaultScopes,
): Array<string> {
	const out = [...base]
	for (const required of setupGitRequiredScopes) {
		if (!out.includes(required)) out.push(required)
	}
	return out
}

export async function fetchTokenCurrentMetadata(input: {
	token: string
	apiUrl?: string
	fetchFn?: typeof fetch
}): Promise<TokenCurrentMetadata> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const current = (await openApiGet({
		token: input.token,
		apiUrl,
		path: 'v1/tokens/current',
		fetchFn: input.fetchFn,
	})) as Record<string, unknown>

	const orgBindingRaw = current.org_binding
	const orgBinding =
		orgBindingRaw === 'user' || orgBindingRaw === 'org' ? orgBindingRaw : null

	return {
		id: String(current.id ?? ''),
		orgBinding,
		scopes: Array.isArray(current.scopes)
			? current.scopes.filter(
					(scope): scope is string => typeof scope === 'string',
				)
			: [],
		expiresAt:
			typeof current.expires_at === 'string' ? current.expires_at : null,
	}
}

/**
 * User-owned tokens (and the git helper) require `org_binding` on token
 * metadata. Older origins omit the field — refuse rather than install a
 * broken helper.
 */
export function assertUserOwnedTokensLive(
	metadata: TokenCurrentMetadata,
): void {
	if (metadata.orgBinding === null) {
		throw new Error(
			'This Kody origin does not advertise user-owned API tokens (`org_binding` missing on GET /v1/tokens/current). Upgrade the server (kody auth setup-git / persistent git HTTPS) before installing the credential helper.',
		)
	}
}

export type SetupGitTokenDecision =
	| { action: 'reuse'; stored: StoredApiToken; metadata: TokenCurrentMetadata }
	| {
			action: 'mint'
			scopes: Array<string>
			lifetime: ResolvedCliTokenLifetime
			reason: string
	  }

/**
 * Reuse a stored user-owned token that already has package:read/write; otherwise
 * mint a long-lived user-owned token with those scopes.
 */
export function decideSetupGitToken(input: {
	stored: StoredApiToken | null
	metadata: TokenCurrentMetadata | null
	scopesOverride?: ReadonlyArray<string>
	lifetime?: ResolvedCliTokenLifetime
}): SetupGitTokenDecision {
	const lifetime =
		input.lifetime ?? resolveCliTokenLifetime({ lifetime: 'long' })

	if (
		input.stored &&
		input.metadata &&
		input.metadata.orgBinding === 'user' &&
		scopesIncludeRequired(input.metadata.scopes) &&
		!input.scopesOverride
	) {
		return { action: 'reuse', stored: input.stored, metadata: input.metadata }
	}

	// Prefer extending the current token's scopes so a parent API token can
	// mint them; fall back to the setup-git default list for a blank slate.
	const scopes = ensureSetupGitScopes(
		input.scopesOverride ??
			input.metadata?.scopes ??
			input.stored?.scopes ??
			setupGitDefaultScopes,
	)

	const reason = !input.stored
		? 'No stored API token yet.'
		: input.metadata?.orgBinding !== 'user'
			? 'Stored token is not user-owned (`org_binding` must be `user`).'
			: !scopesIncludeRequired(input.metadata?.scopes)
				? 'Stored token is missing package:read and/or package:write.'
				: 'Minting with the requested --scopes list.'

	return { action: 'mint', scopes, lifetime, reason }
}

export type GitConfigRunner = (args: ReadonlyArray<string>) => {
	status: number
	stderr: string
}

export function defaultGitConfigRunner(args: ReadonlyArray<string>): {
	status: number
	stderr: string
} {
	const result = spawnSync('git', [...args], {
		encoding: 'utf8',
		env: process.env,
	})
	if (result.error) {
		return { status: 1, stderr: result.error.message }
	}
	return {
		status: result.status ?? 1,
		stderr: (result.stderr || '').trim(),
	}
}

/**
 * Install URL-scoped credential helper config from the server contract:
 * `credential.https://<host>.helper` and `.useHttpPath true`.
 */
export function installGitCredentialConfig(input: {
	host: string
	helperCommand: string
	global?: boolean
	runGit?: GitConfigRunner
}): { host: string; helperCommand: string; scope: '--global' | '--local' } {
	const runGit = input.runGit ?? defaultGitConfigRunner
	const scope = input.global === false ? '--local' : '--global'
	const helperKey = `credential.https://${input.host}.helper`
	const pathKey = `credential.https://${input.host}.useHttpPath`

	for (const [key, value] of [
		[helperKey, input.helperCommand],
		[pathKey, 'true'],
	] as const) {
		const result = runGit(['config', scope, key, value])
		if (result.status !== 0) {
			throw new Error(
				`git config ${scope} ${key} failed${result.stderr ? `: ${result.stderr}` : ''}. Is git installed?`,
			)
		}
	}

	return { host: input.host, helperCommand: input.helperCommand, scope }
}

/** Refresh git HTTPS tokens this long before `expiresAt` (or when past it). */
export const gitApiTokenRefreshSkewMs = 60 * 60 * 1000

/**
 * First published CLI line that includes `git-credential` / `auth setup-git`.
 * Global installs older than this must not be preferred as the helper binary.
 */
export const gitCredentialMinCliVersion = '1.16.0'

/**
 * Fallback exact pin for local `0.0.0-semantically-released` builds. Published
 * tarballs always carry a real x.y.z from semantic-release. Keep this at a
 * recent published line that includes `git-credential` (not merely the
 * minimum) so local/dev pins are not stuck on an ancient helper.
 */
export const gitCredentialHelperPinFallbackVersion = '1.18.0'

const requireFromSetupGit = createRequire(import.meta.url)

export function readCliPackageVersion(): string {
	try {
		const pkg = requireFromSetupGit('../package.json') as { version?: string }
		return typeof pkg.version === 'string'
			? pkg.version
			: gitCredentialHelperPinFallbackVersion
	} catch {
		return gitCredentialHelperPinFallbackVersion
	}
}

/**
 * True when the CLI entry lives under npm's ephemeral `npx` cache
 * (`~/.npm/_npx/…`). Those paths break after `npm cache clean`.
 */
export function isEphemeralNpxEntryPath(entryPath: string): boolean {
	const normalized = entryPath.replace(/\\/g, '/')
	return (
		normalized.includes('/.npm/_npx/') ||
		normalized.includes('/npm/_npx/') ||
		/\/_npx\//.test(normalized)
	)
}

export type CliSemver = { major: number; minor: number; patch: number }

/** Parse a leading `x.y.z` from a CLI version string (ignores prerelease tags). */
export function parseCliSemver(version: string): CliSemver | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
	if (!match) return null
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	}
}

export function compareCliSemver(a: CliSemver, b: CliSemver): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
	return 0
}

export function cliVersionGte(version: string, minimum: string): boolean {
	const left = parseCliSemver(version)
	const right = parseCliSemver(minimum)
	if (!left || !right) return false
	return compareCliSemver(left, right) >= 0
}

export function cliVersionGt(version: string, other: string): boolean {
	const left = parseCliSemver(version)
	const right = parseCliSemver(other)
	if (!left || !right) return false
	return compareCliSemver(left, right) > 0
}

/** True when this CLI version knows the `git-credential` command. */
export function cliVersionSupportsGitCredential(version: string): boolean {
	return cliVersionGte(version, gitCredentialMinCliVersion)
}

/**
 * Exact version for `npx -y @kodycodes/cli@<x.y.z>`. Major-only ranges are
 * unsafe: npx can reuse a stale cache (e.g. 1.1.0 for `@1`). Local
 * `0.0.0-semantically-released` builds fall back to
 * {@link gitCredentialHelperPinFallbackVersion}.
 */
export function cliExactVersionForNpx(packageVersion: string): string {
	const parsed = parseCliSemver(packageVersion)
	if (parsed && parsed.major >= 1) {
		return `${parsed.major}.${parsed.minor}.${parsed.patch}`
	}
	return gitCredentialHelperPinFallbackVersion
}

/** Whether a stored API token should be reminted for git HTTPS. */
export function apiTokenNeedsRefresh(
	stored: Pick<StoredApiToken, 'expiresAt'> | null | undefined,
	nowMs: number = Date.now(),
	skewMs: number = gitApiTokenRefreshSkewMs,
): boolean {
	if (!stored) return true
	if (stored.expiresAt == null || stored.expiresAt === '') return false
	const expiresMs = Date.parse(stored.expiresAt)
	if (!Number.isFinite(expiresMs)) return true
	return expiresMs - nowMs <= skewMs
}

export type KodyVersionReader = (binPath: string) => string | null

/**
 * Read `kody --version` (or `node entry --version`) stdout. Returns null on
 * failure so callers can skip preferring an unverifiable binary.
 *
 * Always sets `KODY_SKIP_GIT_HELPER_REFRESH=1` so a nested CLI does not re-enter
 * pin refresh (which itself may spawn `--version` — an 8s recursive stall).
 */
export function readVersionFromKodyBinary(
	binPath: string,
	args: ReadonlyArray<string> = ['--version'],
): string | null {
	const result = spawnSync(binPath, [...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			KODY_SKIP_GIT_HELPER_REFRESH: '1',
		},
		timeout: 8_000,
	})
	if (result.error || (result.status ?? 1) !== 0) return null
	const text = `${result.stdout || ''}\n${result.stderr || ''}`
	const match = /(\d+\.\d+\.\d+)/.exec(text)
	return match?.[1] ?? null
}

function defaultReadGlobalKodyVersion(binPath: string): string | null {
	return readVersionFromKodyBinary(binPath)
}

/**
 * Helper argv for git config. Prefer a global `kody` only when its version
 * supports `git-credential`; else a non-npx entry path; else
 * `npx -y @kodycodes/cli@<exact>` so npx cannot reuse a stale major-range
 * cache. Re-running `auth setup-git` (and every CLI command via pin refresh)
 * rewrites ephemeral / major-range / outdated pins.
 */
export function gitCredentialHelperCommand(input?: {
	execPath?: string
	entryPath?: string
	env?: NodeJS.ProcessEnv
	which?: typeof whichOnPath
	packageVersion?: string
	readKodyVersion?: KodyVersionReader
}): string {
	const env = input?.env ?? process.env
	const whichFn = input?.which ?? whichOnPath
	const entryPath = input?.entryPath ?? process.argv[1]
	const readVersion = input?.readKodyVersion ?? defaultReadGlobalKodyVersion
	const globalKody = whichFn('kody', env)
	if (globalKody && !isEphemeralNpxEntryPath(globalKody)) {
		const globalVersion = readVersion(globalKody)
		if (globalVersion && cliVersionSupportsGitCredential(globalVersion)) {
			return `!${shellQuote(globalKody)} git-credential`
		}
	}
	if (
		entryPath &&
		entryPath.length > 0 &&
		!isEphemeralNpxEntryPath(entryPath)
	) {
		const execPath = input?.execPath ?? process.execPath
		return `!${shellQuote(execPath)} ${shellQuote(entryPath)} git-credential`
	}
	const exact = cliExactVersionForNpx(
		input?.packageVersion ?? readCliPackageVersion(),
	)
	return `!npx -y ${cliName}@${exact} git-credential`
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Detect major-only npx pins (`@1`, `@2`) that can resolve to a stale cache. */
export function isMajorOnlyNpxHelper(helper: string): boolean {
	return /@kodycodes\/cli@\d+(?![.\d])/.test(helper)
}

/** Exact `@kodycodes/cli@x.y.z` pin from a helper command, if present. */
export function exactNpxHelperVersion(helper: string): string | null {
	const match = /@kodycodes\/cli@(\d+\.\d+\.\d+)/.exec(helper)
	return match?.[1] ?? null
}

/**
 * True when an installed helper should be rewritten: ephemeral npx path,
 * major-only pin, exact pin older than the running CLI, or (when probing) a
 * binary that does not support `git-credential`.
 *
 * Hot-path refresh (`probeBinaryVersion: false`, the default) only uses
 * string heuristics — never spawns `kody --version`. Binary probes stay for
 * `auth setup-git` so we do not pay 8s+ on every CLI / git-credential call.
 */
export function gitCredentialHelperNeedsRepair(input: {
	helper: string | null | undefined
	packageVersion?: string
	readKodyVersion?: KodyVersionReader
	/** Spawn binaries to verify `git-credential` support. Default false. */
	probeBinaryVersion?: boolean
}): boolean {
	const helper = input.helper?.trim()
	if (!helper) return false
	if (isEphemeralNpxEntryPath(helper)) return true
	if (isMajorOnlyNpxHelper(helper)) return true

	const pinned = exactNpxHelperVersion(helper)
	if (pinned) {
		if (!cliVersionSupportsGitCredential(pinned)) return true
		const current = cliExactVersionForNpx(
			input.packageVersion ?? readCliPackageVersion(),
		)
		return cliVersionGt(current, pinned)
	}

	if (input.probeBinaryVersion !== true) {
		// Path-based helpers (`!kody git-credential` / `!node … git-credential`)
		// are left alone on the hot path — spawning --version here was the
		// 8–20s stall (and could recurse into pin refresh).
		return false
	}

	// `!/path/to/kody git-credential` or `!node /path/to/bin.js git-credential`
	const readVersion = input.readKodyVersion ?? defaultReadGlobalKodyVersion
	const bang = helper.startsWith('!') ? helper.slice(1).trim() : helper.trim()
	const parts = bang.split(/\s+/).filter(Boolean)
	if (parts.length >= 2 && parts[parts.length - 1] === 'git-credential') {
		const invocation = parts.slice(0, -1)
		if (invocation.length === 1) {
			const version = readVersion(invocation[0]!)
			if (version && !cliVersionSupportsGitCredential(version)) return true
		} else if (invocation.length >= 2) {
			const version = readVersionFromKodyBinary(invocation[0]!, [
				...invocation.slice(1),
				'--version',
			])
			if (version && !cliVersionSupportsGitCredential(version)) return true
		}
	}
	return false
}

export type GitConfigGetRunner = (args: ReadonlyArray<string>) => {
	status: number
	stdout: string
	stderr: string
}

export function defaultGitConfigGetRunner(args: ReadonlyArray<string>): {
	status: number
	stdout: string
	stderr: string
} {
	const result = spawnSync('git', [...args], {
		encoding: 'utf8',
		env: process.env,
	})
	if (result.error) {
		return { status: 1, stdout: '', stderr: result.error.message }
	}
	return {
		status: result.status ?? 1,
		stdout: (result.stdout || '').trim(),
		stderr: (result.stderr || '').trim(),
	}
}

/**
 * Best-effort: if a Kody HTTPS credential helper is installed but stale,
 * rewrite it to {@link gitCredentialHelperCommand}. Silent — safe to call
 * from every CLI entry including `git-credential` (must not touch stdout).
 * Returns whether a rewrite ran.
 */
export function refreshGitCredentialHelperPinIfNeeded(input?: {
	mcpUrl?: string
	global?: boolean
	packageVersion?: string
	helperCommand?: string
	runGitGet?: GitConfigGetRunner
	runGit?: GitConfigRunner
	readKodyVersion?: KodyVersionReader
	which?: typeof whichOnPath
	execPath?: string
	entryPath?: string
	env?: NodeJS.ProcessEnv
	/** Forwarded to {@link gitCredentialHelperNeedsRepair}. Default false. */
	probeBinaryVersion?: boolean
}): boolean {
	const mcpUrl = input?.mcpUrl || defaultMcpUrl
	const host = gitCredentialHostFromMcpUrl(mcpUrl)
	const scope = input?.global === false ? '--local' : '--global'
	const runGet = input?.runGitGet ?? defaultGitConfigGetRunner
	const helperKey = `credential.https://${host}.helper`
	const got = runGet(['config', scope, '--get', helperKey])
	if (got.status !== 0 || !got.stdout) return false

	const packageVersion = input?.packageVersion ?? readCliPackageVersion()
	if (
		!gitCredentialHelperNeedsRepair({
			helper: got.stdout,
			packageVersion,
			readKodyVersion: input?.readKodyVersion,
			probeBinaryVersion: input?.probeBinaryVersion === true,
		})
	) {
		return false
	}

	const helperCommand =
		input?.helperCommand ??
		gitCredentialHelperCommand({
			packageVersion,
			which: input?.which,
			execPath: input?.execPath,
			entryPath: input?.entryPath,
			env: input?.env,
			readKodyVersion: input?.readKodyVersion,
		})
	if (helperCommand === got.stdout) return false

	installGitCredentialConfig({
		host,
		helperCommand,
		global: input?.global,
		runGit: input?.runGit,
	})
	return true
}

export type AuthSetupGitResult = {
	host: string
	helperCommand: string
	tokenId: string
	scopes: Array<string>
	orgBinding: 'user'
	minted: boolean
	backendKind: string
	backendPath?: string
	expiresAt: string | null
}

export async function authSetupGit(input: {
	apiUrl?: string
	mcpUrl?: string
	token?: string
	scopesOverride?: ReadonlyArray<string>
	lifetime?: ResolvedCliTokenLifetime
	global?: boolean
	/**
	 * True when a `kody login` OAuth session is stored for `mcpUrl`. Login is
	 * enough to mint: the OAuth bearer cannot call `GET /v1/tokens/current`, so
	 * we skip that probe and assert `org_binding` on the minted `kody_at_…`.
	 * The minted token is user-owned (git auth is person-wide across orgs);
	 * login `--org` only scopes the MCP session used to mint.
	 */
	hasLoginSession?: boolean
	mint: (params: Record<string, unknown>) => Promise<unknown>
	fetchFn?: typeof fetch
	backend?: SecretBackend
	resolution?: StoreResolution
	runGit?: GitConfigRunner
	helperCommand?: string
}): Promise<AuthSetupGitResult> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const mcpUrl = input.mcpUrl || defaultMcpUrl
	const host = gitCredentialHostFromMcpUrl(mcpUrl)

	const storedExisting = loadStoredApiToken(
		apiUrl,
		input.backend,
		input.resolution,
	)
	const probeToken = input.token || storedExisting?.token
	const hasLoginSession = input.hasLoginSession === true
	if (!probeToken && !hasLoginSession) {
		throw new Error(
			`setup-git needs a Kody credential to detect server support and mint a token. Run \`kody login\`, or set ${apiTokenEnvVar}, or pass --token.`,
		)
	}

	let probeMetadata: TokenCurrentMetadata | null = null
	if (probeToken) {
		try {
			probeMetadata = await fetchTokenCurrentMetadata({
				token: probeToken,
				apiUrl,
				fetchFn: input.fetchFn,
			})
		} catch (error) {
			if (error instanceof OpenApiError && error.status === 401) {
				throw new Error(
					`Could not read token metadata from ${apiUrl} (unauthorized). Run \`kody login\` or pass a valid --token / ${apiTokenEnvVar}.`,
				)
			}
			throw error
		}
		// Any live token's /tokens/current shape proves the origin supports org_binding.
		assertUserOwnedTokensLive(probeMetadata)
	}

	let storedMetadata: TokenCurrentMetadata | null = null
	if (storedExisting) {
		if (probeMetadata && storedExisting.token === probeToken) {
			storedMetadata = probeMetadata
		} else {
			try {
				storedMetadata = await fetchTokenCurrentMetadata({
					token: storedExisting.token,
					apiUrl,
					fetchFn: input.fetchFn,
				})
			} catch {
				storedMetadata = null
			}
		}
	}

	const decision = decideSetupGitToken({
		stored: storedExisting,
		metadata: storedMetadata,
		scopesOverride: input.scopesOverride,
		lifetime: input.lifetime,
	})

	let stored: StoredApiToken
	let minted = false
	let backendKind: string
	let backendPath: string | undefined

	let finalMetadata: TokenCurrentMetadata

	if (decision.action === 'reuse') {
		stored = decision.stored
		backendKind = 'existing'
		finalMetadata = decision.metadata
	} else {
		const result = await authBootstrapWithScopes({
			scopes: decision.scopes,
			lifetime: decision.lifetime,
			mint: input.mint,
			apiUrl,
			fetchFn: input.fetchFn,
			backend: input.backend,
			resolution: input.resolution,
		})
		stored = result.stored
		minted = true
		backendKind = result.backendKind
		backendPath = result.backendPath

		// Confirm the redeemed token is user-owned (new bootstrap default).
		const after = await fetchTokenCurrentMetadata({
			token: stored.token,
			apiUrl,
			fetchFn: input.fetchFn,
		})
		assertUserOwnedTokensLive(after)
		if (after.orgBinding !== 'user') {
			throw new Error(
				`Minted token ${stored.tokenId} has org_binding=${JSON.stringify(after.orgBinding)}; expected "user". Refusing to install the git helper.`,
			)
		}
		if (!scopesIncludeRequired(after.scopes)) {
			throw new Error(
				`Minted token ${stored.tokenId} is missing package:read and/or package:write. Pass --scopes that include both.`,
			)
		}
		finalMetadata = after
	}

	const helperCommand = input.helperCommand ?? gitCredentialHelperCommand()
	installGitCredentialConfig({
		host,
		helperCommand,
		global: input.global,
		runGit: input.runGit,
	})

	return {
		host,
		helperCommand,
		tokenId: stored.tokenId,
		scopes: finalMetadata.scopes,
		orgBinding: 'user',
		minted,
		backendKind,
		...(backendPath ? { backendPath } : {}),
		expiresAt: finalMetadata.expiresAt,
	}
}

/** Git config scopes `setup-git` may write (never `--system`). */
export const setupGitConfigScopes = ['--global', '--local'] as const

export type GitConfigScope = (typeof setupGitConfigScopes)[number]

export type RemovedGitConfigEntry = {
	scope: GitConfigScope
	key: string
	value: string
}

export type AuthRemoveGitResult = {
	host: string
	removedHelpers: Array<RemovedGitConfigEntry>
	removedPathKeys: Array<
		Omit<RemovedGitConfigEntry, 'value'> & { value?: string }
	>
	tokenId: string | null
	/** Server-side revoke via DELETE /v1/tokens/current (`token:delete`). */
	tokenRevoked: 'yes' | 'no' | 'already' | 'skipped' | 'failed'
	tokenRevokeError?: string
	tokenDeletedLocally: boolean
}

/**
 * True when a URL-scoped helper value was installed by Kody setup-git /
 * pin refresh (exact npx pin, major-only `@1`, ephemeral `_npx`, or a
 * `kody git-credential` invocation).
 */
export function isKodyGitCredentialHelperValue(value: string): boolean {
	const v = value.trim()
	if (!v) return false
	if (v.includes('@kodycodes/cli')) return true
	if (isEphemeralNpxEntryPath(v)) return true
	if (/\bgit-credential\b/.test(v) && /(^|[/\s!])kody(\s|$)/.test(v))
		return true
	if (/\bgit-credential\b/.test(v) && /kody/i.test(v)) return true
	return false
}

/**
 * Inverse of {@link authSetupGit}: remove URL-scoped Kody credential helper
 * entries for the MCP host (global + local), revoke the stored API token
 * server-side, and delete it from the keychain/file store. Leaves `kody login`
 * OAuth sessions alone. Idempotent when nothing is configured.
 */
export async function authRemoveGit(input: {
	apiUrl?: string
	mcpUrl?: string
	fetchFn?: typeof fetch
	backend?: SecretBackend
	resolution?: StoreResolution
	runGitGet?: GitConfigGetRunner
	/** Used for `--unset-all` (status/stderr only). */
	runGit?: GitConfigRunner
}): Promise<AuthRemoveGitResult> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const mcpUrl = input.mcpUrl || defaultMcpUrl
	const host = gitCredentialHostFromMcpUrl(mcpUrl)
	const runGet = input.runGitGet ?? defaultGitConfigGetRunner
	const runGit = input.runGit ?? defaultGitConfigRunner

	const helperKey = `credential.https://${host}.helper`
	const pathKey = `credential.https://${host}.useHttpPath`
	const removedHelpers: Array<RemovedGitConfigEntry> = []
	const removedPathKeys: AuthRemoveGitResult['removedPathKeys'] = []

	for (const scope of setupGitConfigScopes) {
		// URL-scoped keys for this host are owned by setup-git (exact pin,
		// major-only @1, ephemeral _npx, global kody, …). Clear them all.
		const helpers = runGet(['config', scope, '--get-all', helperKey])
		if (helpers.status === 0 && helpers.stdout.trim()) {
			const values = helpers.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
			const unset = runGit(['config', scope, '--unset-all', helperKey])
			if (unset.status === 0) {
				for (const value of values) {
					removedHelpers.push({ scope, key: helperKey, value })
				}
			}
		}

		const pathGot = runGet(['config', scope, '--get-all', pathKey])
		if (pathGot.status === 0 && pathGot.stdout.trim()) {
			const unset = runGit(['config', scope, '--unset-all', pathKey])
			if (unset.status === 0) {
				removedPathKeys.push({
					scope,
					key: pathKey,
					value: pathGot.stdout.trim().split(/\r?\n/)[0],
				})
			}
		}
	}

	const stored = loadStoredApiToken(apiUrl, input.backend, input.resolution)
	let tokenRevoked: AuthRemoveGitResult['tokenRevoked'] = 'skipped'
	let tokenRevokeError: string | undefined
	let tokenId: string | null = stored?.tokenId ?? null

	if (stored?.token) {
		try {
			await openApiRequest({
				token: stored.token,
				apiUrl,
				method: 'DELETE',
				path: 'v1/tokens/current',
				fetchFn: input.fetchFn,
			})
			tokenRevoked = 'yes'
		} catch (error) {
			if (
				error instanceof OpenApiError &&
				(error.status === 401 || error.status === 404)
			) {
				tokenRevoked = 'already'
			} else {
				tokenRevoked = 'failed'
				tokenRevokeError =
					error instanceof Error ? error.message : String(error)
			}
		}
	}

	const deleted = deleteStoredApiToken(apiUrl, input.backend, input.resolution)

	return {
		host,
		removedHelpers,
		removedPathKeys,
		tokenId,
		tokenRevoked,
		...(tokenRevokeError ? { tokenRevokeError } : {}),
		tokenDeletedLocally: deleted.deleted,
	}
}

/** Human-readable lines for `kody auth remove-git` (always prints something). */
export function formatAuthRemoveGitReport(result: AuthRemoveGitResult): string {
	const lines: Array<string> = []
	const removedAnything =
		result.removedHelpers.length > 0 ||
		result.removedPathKeys.length > 0 ||
		result.tokenDeletedLocally ||
		result.tokenRevoked === 'yes' ||
		result.tokenRevoked === 'already'

	if (!removedAnything) {
		return [
			`No Kody Git HTTPS credential helper or stored API token found for https://${result.host}/.`,
			'Nothing to remove. (kody login sessions were not touched.)',
			'',
		].join('\n')
	}

	lines.push(`Removed Kody Git HTTPS setup for https://${result.host}/`)
	for (const entry of result.removedHelpers) {
		lines.push(`  ${entry.scope} ${entry.key}: ${entry.value}`)
	}
	for (const entry of result.removedPathKeys) {
		lines.push(
			`  ${entry.scope} ${entry.key}${entry.value ? `: ${entry.value}` : ''}`,
		)
	}

	if (result.tokenRevoked === 'yes') {
		lines.push(
			`Revoked API token${result.tokenId ? ` ${result.tokenId}` : ''} on the server (token:delete).`,
		)
	} else if (result.tokenRevoked === 'already') {
		lines.push(
			`API token${result.tokenId ? ` ${result.tokenId}` : ''} already revoked or expired on the server.`,
		)
	} else if (result.tokenRevoked === 'failed') {
		lines.push(
			`Could not revoke API token on the server${result.tokenRevokeError ? `: ${result.tokenRevokeError}` : '.'}`,
		)
	} else if (result.tokenRevoked === 'skipped') {
		lines.push('No stored API token to revoke.')
	}

	if (result.tokenDeletedLocally) {
		lines.push(
			'Deleted stored API token from the OS keychain (and file fallback).',
		)
	} else if (result.tokenRevoked !== 'skipped') {
		lines.push('Stored API token was already absent from the local store.')
	}

	lines.push('Left kody login sessions alone.')
	lines.push('')
	return lines.join('\n')
}

export { cliTokenLifetimeAliases }
