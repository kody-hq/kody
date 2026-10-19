import {
	assertTokenSafeApiUrl,
	capabilityProxyUrl,
} from './capability-proxy.js'
import { cliName, defaultApiUrl } from './defaults.js'
import { summarizeNonJsonErrorBody } from './http-error-body.js'
import {
	formatUnreachableApiMessage,
	requestSentStatus,
	type RequestSentStatus,
} from './network-error.js'
import { readPackageVersion } from './package-info.js'
import { saveStoredApiToken, type StoredApiToken } from './api-token-store.js'
import { type SecretBackend, type StoreResolution } from './store.js'

/** ADR 0056 one-shot bootstrap code prefix (`kody_bc_…`). */
export const cliBootstrapCodePrefix = 'kody_bc_'

/** Platform shape: `kody_bc_<16 alnum>_<32 base64url>`. */
const bootstrapCodePattern = /^kody_bc_([a-z0-9]{16})_([A-Za-z0-9_-]{32})$/

export const bootstrapRedeemPath = 'v1/tokens/bootstrap/redeem'

/** ADR 0056 idle / absolute lifetime caps (seconds). */
export const cliTokenLifetimePolicy = {
	minIdleTtlSeconds: 60,
	/** Idle timeout at most 14 days. */
	maxIdleTtlSeconds: 14 * 24 * 60 * 60,
	/** Absolute lifetime at most 3 months. */
	maxMaxLifetimeSeconds: 90 * 24 * 60 * 60,
} as const

/**
 * Input aliases for required token lifetimes. Sugar only: never stored on the
 * token. `short` suits single-task agents; `long` is the policy maximum.
 */
export const cliTokenLifetimeAliases = {
	short: {
		idleTtlSeconds: 60 * 60,
		maxLifetimeSeconds: 24 * 60 * 60,
	},
	long: {
		idleTtlSeconds: cliTokenLifetimePolicy.maxIdleTtlSeconds,
		maxLifetimeSeconds: cliTokenLifetimePolicy.maxMaxLifetimeSeconds,
	},
} as const

export type CliTokenLifetimeAlias = keyof typeof cliTokenLifetimeAliases

/**
 * Resolved lifetime for redeem. Alias form keeps the label only for the
 * redeem JSON body (`lifetime`); explicit form sends idle/max seconds.
 * Neither label nor alias is persisted with the stored API token.
 */
export type ResolvedCliTokenLifetime =
	| {
			kind: 'alias'
			lifetime: CliTokenLifetimeAlias
			idleTtlSeconds: number
			maxLifetimeSeconds: number
	  }
	| {
			kind: 'explicit'
			idleTtlSeconds: number
			maxLifetimeSeconds: number
	  }

export type BootstrapRedeemResponse = {
	token: string
	token_type?: string
	id: string
	name?: string | null
	scopes?: Array<string>
	status?: string
	idle_ttl_seconds?: number
	expires_at?: string | null
	max_expires_at?: string | null
	created_via?: string
}

export type BootstrapRedeemRequestBody =
	| { code: string; lifetime: CliTokenLifetimeAlias }
	| {
			code: string
			idle_ttl_seconds: number
			max_lifetime_seconds: number
	  }

export function parseCliBootstrapCode(
	value: string,
): { codeId: string; secret: string } | null {
	const match = bootstrapCodePattern.exec(value.trim())
	if (!match) return null
	const [, codeId, secret] = match
	if (!codeId || !secret) return null
	return { codeId, secret }
}

export function assertCliBootstrapCode(code: string): string {
	const trimmed = code.trim()
	if (!parseCliBootstrapCode(trimmed)) {
		throw new Error(
			`Invalid bootstrap code. Expected a one-shot ${cliBootstrapCodePrefix}… from cliCredentialBootstrap (MCP api / kody.cliCredentialBootstrap).`,
		)
	}
	return trimmed
}

/** Exact CLI flag syntax for a missing lifetime (ADR 0056). */
export function cliTokenLifetimeMissingError(): string {
	return (
		'Token lifetime is required. Pass --lifetime short|long, or both ' +
		`--idle-ttl-seconds <n> and --max-lifetime-seconds <n> ` +
		`(idle ${cliTokenLifetimePolicy.minIdleTtlSeconds}-${cliTokenLifetimePolicy.maxIdleTtlSeconds}s, ` +
		`max age up to ${cliTokenLifetimePolicy.maxMaxLifetimeSeconds}s). ` +
		'Single-task agents should use --lifetime short.'
	)
}

/**
 * Resolve a required lifetime choice. Aliases expand to idle/max seconds for
 * validation; the redeem body still sends the alias or explicit seconds only.
 */
export function resolveCliTokenLifetime(input: {
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
}): ResolvedCliTokenLifetime {
	const aliasRaw =
		typeof input.lifetime === 'string' ? input.lifetime.trim() : ''
	const hasAlias = aliasRaw.length > 0
	const hasIdle = input.idleTtlSeconds !== undefined
	const hasMax = input.maxLifetimeSeconds !== undefined

	if (!hasAlias && !hasIdle && !hasMax) {
		throw new Error(cliTokenLifetimeMissingError())
	}
	if (hasAlias && (hasIdle || hasMax)) {
		throw new Error(
			'Pass --lifetime short|long, or both --idle-ttl-seconds and --max-lifetime-seconds, not both forms.',
		)
	}
	if (hasAlias) {
		if (!(aliasRaw in cliTokenLifetimeAliases)) {
			throw new Error(
				`--lifetime must be short or long (got ${JSON.stringify(aliasRaw)}).`,
			)
		}
		const lifetime = aliasRaw as CliTokenLifetimeAlias
		const resolved = cliTokenLifetimeAliases[lifetime]
		return {
			kind: 'alias',
			lifetime,
			idleTtlSeconds: resolved.idleTtlSeconds,
			maxLifetimeSeconds: resolved.maxLifetimeSeconds,
		}
	}
	if (!hasIdle || !hasMax) {
		throw new Error(
			'When not using --lifetime short|long, both --idle-ttl-seconds and --max-lifetime-seconds are required.',
		)
	}
	const idleTtlSeconds = readRequiredInteger({
		value: input.idleTtlSeconds!,
		min: cliTokenLifetimePolicy.minIdleTtlSeconds,
		max: cliTokenLifetimePolicy.maxIdleTtlSeconds,
		field: '--idle-ttl-seconds',
	})
	const maxLifetimeSeconds = readRequiredInteger({
		value: input.maxLifetimeSeconds!,
		min: idleTtlSeconds,
		max: cliTokenLifetimePolicy.maxMaxLifetimeSeconds,
		field: '--max-lifetime-seconds',
	})
	return {
		kind: 'explicit',
		idleTtlSeconds,
		maxLifetimeSeconds,
	}
}

/** Build the redeem JSON body (alias or explicit seconds — never both). */
export function bootstrapRedeemRequestBody(
	code: string,
	lifetime: ResolvedCliTokenLifetime,
): BootstrapRedeemRequestBody {
	if (lifetime.kind === 'alias') {
		return { code, lifetime: lifetime.lifetime }
	}
	return {
		code,
		idle_ttl_seconds: lifetime.idleTtlSeconds,
		max_lifetime_seconds: lifetime.maxLifetimeSeconds,
	}
}

/** Parse a CLI `--idle-ttl-seconds` / `--max-lifetime-seconds` string flag. */
export function parseCliLifetimeSecondsFlag(
	raw: string | undefined,
	flag: '--idle-ttl-seconds' | '--max-lifetime-seconds',
): number | undefined {
	if (raw === undefined) return undefined
	const trimmed = raw.trim()
	if (!/^-?\d+$/.test(trimmed)) {
		throw new Error(`${flag} must be an integer.`)
	}
	return Number(trimmed)
}

/**
 * Lifetime for redeem after a successful mint. Trusts the server's clamped
 * idle/max seconds (may be below CLI flag mins, or max below the requested
 * idle). Only coerces idle down when max < idle so the pair stays consistent.
 */
export function resolveMintedRedeemLifetime(minted: {
	idle_ttl_seconds: number
	max_lifetime_seconds: number
}): Extract<ResolvedCliTokenLifetime, { kind: 'explicit' }> {
	const maxLifetimeSeconds = minted.max_lifetime_seconds
	const idleTtlSeconds = Math.min(minted.idle_ttl_seconds, maxLifetimeSeconds)
	return {
		kind: 'explicit',
		idleTtlSeconds,
		maxLifetimeSeconds,
	}
}

/**
 * POST /v1/tokens/bootstrap/redeem with JSON `{ code, lifetime }` or
 * `{ code, idle_ttl_seconds, max_lifetime_seconds }` and **no** Authorization
 * header (ADR 0056). Returns the minted `kody_at_…` once.
 *
 * Pass `trustedMintLifetime` after cliCredentialBootstrap so server-clamped
 * seconds are redeemed without re-applying CLI flag mins (max may be below
 * the requested idle or below `--idle-ttl-seconds` minimum).
 */
export async function redeemBootstrapCode(input: {
	code: string
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	trustedMintLifetime?: {
		idle_ttl_seconds: number
		max_lifetime_seconds: number
	}
	apiUrl?: string
	fetchFn?: typeof fetch
}): Promise<BootstrapRedeemResponse> {
	const code = assertCliBootstrapCode(input.code)
	const lifetime = input.trustedMintLifetime
		? resolveMintedRedeemLifetime(input.trustedMintLifetime)
		: resolveCliTokenLifetime({
				lifetime: input.lifetime,
				idleTtlSeconds: input.idleTtlSeconds,
				maxLifetimeSeconds: input.maxLifetimeSeconds,
			})
	const apiUrl = input.apiUrl || defaultApiUrl
	assertTokenSafeApiUrl(apiUrl)
	const url = capabilityProxyUrl(apiUrl, bootstrapRedeemPath)
	const fetchFn = input.fetchFn ?? fetch
	let response: Response
	try {
		response = await fetchFn(url, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
			body: JSON.stringify(bootstrapRedeemRequestBody(code, lifetime)),
		})
	} catch (error) {
		const unreachable = new Error(
			formatUnreachableApiMessage({ origin: url.origin, error }),
		) as Error & { sent: RequestSentStatus }
		unreachable.sent = requestSentStatus(error)
		throw unreachable
	}
	const body = await readJson(response)
	if (!response.ok) {
		throw describeRedeemFailure(response.status, body, url)
	}
	return parseRedeemResponse(body)
}

export function storedApiTokenFromRedeem(input: {
	apiUrl: string
	redeemed: BootstrapRedeemResponse
}): StoredApiToken {
	const token = input.redeemed.token.trim()
	if (!token.startsWith('kody_at_')) {
		throw new Error(
			'Bootstrap redeem did not return a scoped kody_at_… API token.',
		)
	}
	return {
		version: 1,
		apiUrl: input.apiUrl,
		token,
		tokenId: input.redeemed.id,
		...(input.redeemed.name ? { name: input.redeemed.name } : {}),
		...(Array.isArray(input.redeemed.scopes)
			? { scopes: input.redeemed.scopes }
			: {}),
		expiresAt: input.redeemed.expires_at ?? null,
		maxExpiresAt: input.redeemed.max_expires_at ?? null,
		createdVia: input.redeemed.created_via ?? 'cli-bootstrap',
	}
}

/**
 * Redeem a one-shot `kody_bc_…` and persist the resulting API token for
 * `execute --local`. Never returns the token string to callers that print
 * success output — use `stored.tokenId` / backend kind only.
 */
export async function authBootstrap(input: {
	code: string
	lifetime?: string | null
	idleTtlSeconds?: number
	maxLifetimeSeconds?: number
	apiUrl?: string
	fetchFn?: typeof fetch
	backend?: SecretBackend
	resolution?: StoreResolution
}): Promise<{
	stored: StoredApiToken
	backendKind: SecretBackend['kind']
	backendPath?: string
}> {
	const apiUrl = input.apiUrl || defaultApiUrl
	const redeemed = await redeemBootstrapCode({
		code: input.code,
		lifetime: input.lifetime,
		idleTtlSeconds: input.idleTtlSeconds,
		maxLifetimeSeconds: input.maxLifetimeSeconds,
		apiUrl,
		fetchFn: input.fetchFn,
	})
	const stored = storedApiTokenFromRedeem({ apiUrl, redeemed })
	const saved = saveStoredApiToken(stored, input.backend, input.resolution)
	return {
		stored,
		backendKind: saved.backend.kind,
		...(saved.backend.path ? { backendPath: saved.backend.path } : {}),
	}
}

export const cliCredentialBootstrapOperationId = 'cliCredentialBootstrap'

export type BootstrapMintResponse = {
	bootstrap_code: string
	scopes: Array<string>
	idle_ttl_seconds: number
	max_lifetime_seconds: number
}

/**
 * Parse `--scopes`. Comma- or space-separated, deduped, order kept. The list
 * replaces cliCredentialBootstrap's default scopes; the server validates names.
 */
export function parseCliScopesFlag(
	raw: string | undefined,
): Array<string> | undefined {
	if (raw === undefined) return undefined
	const scopes = [
		...new Set(
			raw
				.split(/[\s,]+/)
				.map((scope) => scope.trim())
				.filter(Boolean),
		),
	]
	if (scopes.length === 0) {
		throw new Error(
			'--scopes needs at least one scope (e.g. --scopes org:execute,package:write).',
		)
	}
	return scopes
}

/** cliCredentialBootstrap params for an explicit scope list and lifetime. */
export function bootstrapMintParams(
	scopes: ReadonlyArray<string>,
	lifetime: ResolvedCliTokenLifetime,
): Record<string, unknown> {
	return {
		scopes: [...scopes],
		...bootstrapMintLifetimeFields(lifetime),
	}
}

export function bootstrapMintLifetimeFields(
	lifetime: ResolvedCliTokenLifetime,
): Record<string, string | number> {
	return lifetime.kind === 'alias'
		? { lifetime: lifetime.lifetime }
		: {
				idle_ttl_seconds: lifetime.idleTtlSeconds,
				max_lifetime_seconds: lifetime.maxLifetimeSeconds,
			}
}

export function parseBootstrapMintResponse(
	body: unknown,
): BootstrapMintResponse {
	if (
		!isRecord(body) ||
		typeof body.bootstrap_code !== 'string' ||
		typeof body.idle_ttl_seconds !== 'number' ||
		typeof body.max_lifetime_seconds !== 'number'
	) {
		throw new Error('cliCredentialBootstrap returned an unexpected response.')
	}
	return {
		bootstrap_code: body.bootstrap_code,
		scopes: Array.isArray(body.scopes)
			? body.scopes.filter(
					(scope): scope is string => typeof scope === 'string',
				)
			: [],
		idle_ttl_seconds: body.idle_ttl_seconds,
		max_lifetime_seconds: body.max_lifetime_seconds,
	}
}

/**
 * Mint a bootstrap code with explicit `scopes` through the caller's current
 * Kody credential, then redeem and store it like `authBootstrap`. Redeems with
 * the minted idle/max seconds because the server may clamp the max lifetime to
 * a parent API token's remaining lifetime — those values must not be
 * re-validated as CLI lifetime flags (which would burn the one-shot code).
 */
export async function authBootstrapWithScopes(input: {
	scopes: ReadonlyArray<string>
	lifetime: ResolvedCliTokenLifetime
	mint: (params: Record<string, unknown>) => Promise<unknown>
	apiUrl?: string
	fetchFn?: typeof fetch
	backend?: SecretBackend
	resolution?: StoreResolution
}): Promise<Awaited<ReturnType<typeof authBootstrap>>> {
	const minted = parseBootstrapMintResponse(
		await input.mint(bootstrapMintParams(input.scopes, input.lifetime)),
	)
	const apiUrl = input.apiUrl || defaultApiUrl
	const redeemed = await redeemBootstrapCode({
		code: minted.bootstrap_code,
		trustedMintLifetime: {
			idle_ttl_seconds: minted.idle_ttl_seconds,
			max_lifetime_seconds: minted.max_lifetime_seconds,
		},
		apiUrl,
		fetchFn: input.fetchFn,
	})
	const stored = storedApiTokenFromRedeem({ apiUrl, redeemed })
	const saved = saveStoredApiToken(stored, input.backend, input.resolution)
	return {
		stored,
		backendKind: saved.backend.kind,
		...(saved.backend.path ? { backendPath: saved.backend.path } : {}),
	}
}

function readRequiredInteger(input: {
	value: number
	min: number
	max: number
	field: string
}): number {
	if (
		!Number.isInteger(input.value) ||
		input.value < input.min ||
		input.value > input.max
	) {
		throw new Error(
			`${input.field} must be an integer between ${input.min} and ${input.max}.`,
		)
	}
	return input.value
}

function parseRedeemResponse(body: unknown): BootstrapRedeemResponse {
	if (
		!isRecord(body) ||
		typeof body.token !== 'string' ||
		typeof body.id !== 'string'
	) {
		throw new Error('Bootstrap redeem returned an unexpected response.')
	}
	return {
		token: body.token,
		token_type:
			typeof body.token_type === 'string' ? body.token_type : undefined,
		id: body.id,
		name: typeof body.name === 'string' ? body.name : null,
		scopes: Array.isArray(body.scopes)
			? body.scopes.filter(
					(scope): scope is string => typeof scope === 'string',
				)
			: undefined,
		status: typeof body.status === 'string' ? body.status : undefined,
		idle_ttl_seconds:
			typeof body.idle_ttl_seconds === 'number'
				? body.idle_ttl_seconds
				: undefined,
		expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
		max_expires_at:
			typeof body.max_expires_at === 'string' ? body.max_expires_at : null,
		created_via:
			typeof body.created_via === 'string' ? body.created_via : undefined,
	}
}

function describeRedeemFailure(status: number, body: unknown, url: URL): Error {
	const failure = readErrorBody(body)
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	if (status === 400 || status === 401 || status === 403 || status === 404) {
		return new Error(
			`Bootstrap redeem failed (HTTP ${status}). The code may be invalid, expired, or already used. Call cliCredentialBootstrap again for a fresh code.${detail}`,
		)
	}
	return new Error(
		failure?.message ??
			`Bootstrap redeem failed with HTTP ${status} (${url.pathname}).${detail}`,
	)
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function readErrorBody(
	body: unknown,
): { code: string | null; message: string } | null {
	if (!isRecord(body) || body.error == null) {
		if (typeof body === 'string' && body.trim()) {
			return { code: null, message: summarizeNonJsonErrorBody(body) }
		}
		if (isRecord(body) && typeof body.message === 'string') {
			return { code: null, message: body.message }
		}
		return null
	}
	const { error } = body
	if (typeof error === 'string') return { code: null, message: error }
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : null
		const message =
			typeof error.message === 'string'
				? error.message
				: (code ?? JSON.stringify(error))
		return { code, message }
	}
	return { code: null, message: String(error) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
