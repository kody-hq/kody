/**
 * Sealed tokens (ADR 0068, 2026-10-27 amendment): a token Kody derived for
 * code (an OAuth access or refresh token, an id token, a signed JWT) comes
 * back as an integration-token placeholder whose name is the token encrypted
 * by the host. Code can pass it into a fetch header or body; the gateway
 * opens it there and fills the value. Code never holds the value.
 *
 * A sealed token is bound to its org, the run that received it (when the
 * run has a binding), the registrable domains it may be sent to, and an
 * expiry. A JWT access token may also go to the host its https `aud` names
 * (ADR 0068, 2026-10-28 amendment). A token from a token endpoint may be
 * saved as a Key through `secretSet({ sealed_token })`; the host opens it
 * and stores the value, which code still never holds.
 *
 * A sealed token remembers the stored secrets it was minted with and their
 * approved hosts, so a token exchanged for it (a `secretJwtSign` JWT sent to
 * Google's token endpoint) fills on those hosts too (ADR 0068, 2026-11-14
 * amendment).
 */
import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { getDomain } from 'tldts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { withLanding } from '#mcp/secrets/echo-redaction.ts'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import { buildIntegrationTokenPlaceholder } from '#mcp/secrets/placeholders.ts'
import { credentialHostsAllow } from '#worker/credentials/credential-request.ts'
import { type SecretScope, secretScopeValues } from '#mcp/secrets/types.ts'

export const sealedTokenNamePrefix = 'kody-sealed.'
/** A `domains` entry that lets a sealed token fill on any host. */
export const anySealedTokenDomain = '*'
/** Day `secretJwtSign` starts requiring an https `aud` or `send_to_host`. */
export const jwtSignSendToHostRequiredDate = '2026-12-02'
/**
 * Midnight America/Denver on that day. From then `secretJwtSign` refuses an
 * any-host JWT and `anySealedTokenDomain` no longer fills (kody-hq/kody#4456).
 */
export const jwtSignSendToHostRequiredAt = Date.parse(
	`${jwtSignSendToHostRequiredDate}T00:00:00-07:00`,
)

export function jwtSignMayFillAnyHost(now = Date.now()) {
	return now < jwtSignSendToHostRequiredAt
}
export const sealedTokenFields = [
	'access_token',
	'refresh_token',
	'id_token',
] as const
const maxLifetimeMs = 60 * 60 * 1000
const keyInfo = new TextEncoder().encode('kody/sealed-token/v1')

const sealedPayloadSchema = z.object({
	v: z.string().min(1),
	org: z.string().min(1),
	binding: z.string().min(1).nullable(),
	domains: z.array(z.string().min(1)).min(1),
	exp: z.number(),
	/** Where the token came from, for the refusal hint. */
	src: z.enum(['jwt-sign', 'token-response']).optional(),
	/** Hosts the token's https `aud` names, for the refusal hint. */
	aud: z.array(z.string().min(1)).optional(),
	/**
	 * Exact hosts a saved copy may be sent to. Absent: the token cannot be
	 * saved. Empty: the token repeats a filled credential.
	 */
	save: z.array(z.string().min(1)).optional(),
	/**
	 * Stored secrets this token was minted with, and their approved hosts. A
	 * token a request filled with this one returns is sealed to them too.
	 */
	via: z
		.array(
			z.object({
				secret: z.string().min(1),
				scope: z.enum(secretScopeValues),
				hosts: z.array(z.string().min(1)),
			}),
		)
		.optional(),
	/**
	 * Package that minted an any-host JWT ('' outside a package), so each
	 * fill host is counted per caller (kody-hq/kody#4456).
	 */
	pkg: z.string().optional(),
})

type SealedTokenEnv = Pick<Env, 'SECRET_STORE_KEY'>

/** A stored secret a token was minted with, and the hosts it is approved for. */
export type SealedTokenMinter = {
	secret: string
	scope: SecretScope
	hosts: ReadonlyArray<string>
}

export type SealedTokenBinding = {
	org: string
	binding: string | null
	domains: ReadonlyArray<string>
	source?: 'jwt-sign' | 'token-response'
	/** Exact hosts a saved copy may be sent to (see `openSealedTokenForSave`). */
	saveHosts?: ReadonlyArray<string>
	/** Set on an any-host JWT: the package that minted it, '' outside one. */
	anyHostPackageId?: string
	/** Stored secrets the token was minted with (see `SealedTokenMinter`). */
	mintedWith?: ReadonlyArray<SealedTokenMinter>
}

async function sealingKey(env: SealedTokenEnv) {
	if (!env.SECRET_STORE_KEY) {
		throw new Error('SECRET_STORE_KEY is required to seal tokens.')
	}
	const base = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.SECRET_STORE_KEY),
		'HKDF',
		false,
		['deriveKey'],
	)
	return await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: keyInfo },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	)
}

/** The registrable domain a sealed token minted at `url` may be sent to. */
export function sealedTokenDomainForUrl(url: string | URL) {
	try {
		const host = new URL(url).hostname.toLowerCase()
		return getDomain(host, { allowPrivateDomains: true }) ?? host
	} catch {
		return null
	}
}

export function isSealedTokenName(name: string) {
	return name.startsWith(sealedTokenNamePrefix)
}

/** Seals `value`; returns the placeholder code receives in its place. */
export async function sealToken(input: {
	env: SealedTokenEnv
	value: string
	to: SealedTokenBinding
	/** Seconds the provider says the token lives; capped at one hour. */
	expiresInSeconds?: number | null
	/** Exact hosts (no subdomains) the token's audience names. */
	audienceHosts?: ReadonlyArray<string>
	now?: number
}) {
	const now = input.now ?? Date.now()
	const lifetimeMs =
		typeof input.expiresInSeconds === 'number' &&
		Number.isFinite(input.expiresInSeconds)
			? Math.min(Math.max(input.expiresInSeconds, 0) * 1000, maxLifetimeMs)
			: maxLifetimeMs
	const audienceHosts = input.audienceHosts ?? []
	const payload: z.infer<typeof sealedPayloadSchema> = {
		v: input.value,
		org: input.to.org,
		binding: input.to.binding,
		domains: [...new Set(input.to.domains)],
		exp: now + lifetimeMs,
		...(input.to.source ? { src: input.to.source } : {}),
		...(audienceHosts.length > 0 ? { aud: [...audienceHosts] } : {}),
		...(input.to.saveHosts ? { save: [...new Set(input.to.saveHosts)] } : {}),
		...(input.to.mintedWith?.length
			? {
					via: input.to.mintedWith.map((minter) => ({
						secret: minter.secret,
						scope: minter.scope,
						hosts: [...new Set(minter.hosts)],
					})),
				}
			: {}),
		...(input.to.anyHostPackageId === undefined
			? {}
			: { pkg: input.to.anyHostPackageId }),
	}
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		await sealingKey(input.env),
		new TextEncoder().encode(JSON.stringify(payload)),
	)
	return buildIntegrationTokenPlaceholder(
		`${sealedTokenNamePrefix}${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(sealed))}`,
	)
}

const sealedTokenSlot = 'sealed token'

function refuse(message: string): never {
	throw new SecretPlacementError(message, sealedTokenSlot)
}

type OpenSealedTokenInput = {
	env: SealedTokenEnv
	name: string
	org: string
	binding: string | null
	now?: number
}

/** Decrypts a sealed token and refuses another org, another run, or expiry. */
async function openSealedPayload(
	input: OpenSealedTokenInput,
	fail: (message: string) => never,
) {
	const encoded = input.name.slice(sealedTokenNamePrefix.length)
	const [ivText, sealedText, extra] = encoded.split('.')
	if (!ivText || !sealedText || extra !== undefined) {
		fail('This sealed token is malformed.')
	}
	let payload: z.infer<typeof sealedPayloadSchema>
	try {
		const opened = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: base64UrlToBytes(ivText) },
			await sealingKey(input.env),
			base64UrlToBytes(sealedText),
		)
		payload = sealedPayloadSchema.parse(
			JSON.parse(new TextDecoder().decode(opened)),
		)
	} catch {
		fail('This sealed token was not issued by this Kody.')
	}
	if (payload.org !== input.org) {
		fail('This sealed token belongs to another account.')
	}
	if (payload.binding && payload.binding !== input.binding) {
		fail(
			'This sealed token belongs to another run. Mint a new one in this run.',
		)
	}
	if ((input.now ?? Date.now()) >= payload.exp) {
		fail('This sealed token expired. Mint a new one.')
	}
	return payload
}

/**
 * Opens a sealed token for a gateway fill. Refuses another org, another
 * run, an expired token, a host outside its domains, and the URL. Returns
 * the value and the stored secrets it was minted with, so a token the
 * request returns is sealed to their approved hosts too.
 */
export async function openSealedToken(
	input: OpenSealedTokenInput & {
		requestHost: string
		parts: ReadonlyArray<string>
		/** Called when an any-host JWT fills, with the caller that minted it. */
		onAnyHostFill?: (caller: { ownerId: string; packageId: string }) => void
		/** Link that approves the request host on a minting secret. */
		hostApprovalUrl?: (minter: SealedTokenMinter) => string
	},
): Promise<{ value: string; mintedWith: Array<SealedTokenMinter> }> {
	const payload = await openSealedPayload(input, refuse)
	const host = input.requestHost.toLowerCase()
	const anyHost = jwtSignMayFillAnyHost(input.now)
	if (
		!payload.domains.some(
			(domain) =>
				(domain === anySealedTokenDomain && anyHost) ||
				host === domain ||
				host.endsWith(`.${domain}`),
		) &&
		!payload.aud?.includes(host) &&
		!payload.via?.some((minter) => credentialHostsAllow(minter.hosts, host))
	) {
		const allowed = new Set([
			...payload.domains,
			...(payload.aud ?? []),
			...(payload.via ?? []).flatMap((minter) => minter.hosts),
		])
		refuse(
			`A sealed token may only be sent to ${[...allowed].join(', ')}, not ${host}. ${refusedHostHint(payload, host, input.hostApprovalUrl)}`,
		)
	}
	const urlPart = input.parts.find(
		(part) => part === 'query' || part === 'path',
	)
	if (urlPart) {
		refuse(
			`A sealed token fills a header or the body, not the ${urlPart}, because hosts log URLs.`,
		)
	}
	if (
		payload.pkg !== undefined &&
		payload.domains.includes(anySealedTokenDomain)
	) {
		input.onAnyHostFill?.({ ownerId: payload.org, packageId: payload.pkg })
	}
	return { value: payload.v, mintedWith: payload.via ?? [] }
}

function refusedHostHint(
	payload: z.infer<typeof sealedPayloadSchema>,
	host: string,
	hostApprovalUrl: ((minter: SealedTokenMinter) => string) | undefined,
) {
	const hints: Array<string> = []
	if (payload.src === 'jwt-sign') {
		hints.push(
			`If ${host} is where this JWT goes, set its "aud" claim to https://${host} or pass send_to_host: "${host}" to secretJwtSign.`,
		)
	} else if (payload.aud?.length) {
		hints.push(
			`It was issued for ${payload.aud.map((aud) => `https://${aud}`).join(', ')}; if ${host} is a different API, mint a token whose scope or resource is ${host}'s API.`,
		)
	} else {
		hints.push(
			`It names no https audience Kody can read. If ${host} is the API it is for, have the identity provider issue a JWT access token whose "aud" is https://${host}.`,
		)
	}
	const minters = payload.via ?? []
	if (minters.length) {
		const approvals = minters.map((minter) => {
			const url = hostApprovalUrl?.(minter)
			return `"${minter.secret}"${url ? ` (${url})` : ''}`
		})
		hints.push(
			`It was minted with ${minters.map((minter) => `secret "${minter.secret}", approved for ${minter.hosts.join(', ') || 'no hosts'}`).join('; ')}. None of those approves ${host}; to send it there, approve ${host} on ${approvals.join(' or ')}.`,
		)
	} else if (payload.src !== 'jwt-sign') {
		hints.push(
			`No stored secret filled the request that minted it, so no secret's approved hosts apply.`,
		)
	}
	return hints.join(' ')
}

/**
 * Hosts an access token is issued for, beyond `domains`: the https `aud` host
 * of a JWT, plus the hosts Microsoft documents for an Entra resource whose
 * identifier names another host. The identity provider chose `aud`; code only
 * asked, and a token is only good at its audience. Exact hosts, not
 * registrable domains, keep an `azure.com` audience off tenant-named hosts
 * such as `<label>.<region>.cloudapp.azure.com`. A token naming two outside
 * audiences gets none, so it cannot carry one API's access to another host.
 */
export function sealedTokenAudienceHosts(
	token: string,
	domains: ReadonlyArray<string> = [],
) {
	const covered = (host: string) =>
		domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
	const outside = new Map<string, Array<string>>()
	for (const host of readJwtAudiences(token).map(audienceHost)) {
		if (host === null) continue
		const hosts = [host, ...(entraResourceHostAliases[host] ?? [])].filter(
			(candidate) => !covered(candidate),
		)
		if (hosts.length > 0) outside.set(host, hosts)
	}
	if (outside.size !== 1) return []
	return [...outside.values()][0]!
}

/**
 * Entra resource identifiers served at a host the identifier does not name.
 * Only add a pair Microsoft documents, and only hosts Microsoft operates.
 */
const entraResourceHostAliases: Record<string, ReadonlyArray<string>> = {
	// https://learn.microsoft.com/azure/azure-monitor/logs/api/access-api
	'api.loganalytics.io': ['api.loganalytics.azure.com'],
	// The classic ARM resource; Azure Resource Manager accepts both.
	'management.core.windows.net': ['management.azure.com'],
}

function readJwtAudiences(token: string) {
	const parts = token.split('.')
	if (parts.length !== 3 || !parts[1]) return []
	let claims: unknown
	try {
		claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])))
	} catch {
		return []
	}
	if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return []
	const aud = (claims as Record<string, unknown>).aud
	const audiences = Array.isArray(aud) ? aud : [aud]
	return audiences.filter((value): value is string => typeof value === 'string')
}

function audienceHost(aud: string) {
	if (!/^https:\/\//i.test(aud)) return null
	let host: string
	try {
		host = new URL(aud).hostname.toLowerCase().replace(/\.$/, '')
	} catch {
		return null
	}
	// A public suffix, an IP, or a single label names no one API.
	return getDomain(host, { allowPrivateDomains: true }) ? host : null
}

/**
 * Replaces the token fields of a JSON object with sealed tokens. Returns
 * null when there is nothing to seal. An `access_token` JWT may also fill on
 * the hosts its https `aud` names (see `sealedTokenAudienceHosts`).
 */
export async function sealTokenFields(input: {
	env: SealedTokenEnv
	payload: unknown
	to: SealedTokenBinding
	/** Credential values filled into the request; see `audienceHostsFor`. */
	filledValues?: ReadonlyArray<string>
}) {
	const { payload } = input
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null
	}
	const record = payload as Record<string, unknown>
	if (!sealedTokenFields.some((field) => typeof record[field] === 'string')) {
		return null
	}
	const expiresIn =
		typeof record.expires_in === 'number'
			? record.expires_in
			: typeof record.expires_in === 'string'
				? Number(record.expires_in)
				: null
	const next: Record<string, unknown> = { ...record }
	for (const field of sealedTokenFields) {
		const value = record[field]
		if (typeof value !== 'string' || !value) continue
		const echoes = repeatsFilledValue(value, input.filledValues)
		next[field] = await sealToken({
			env: input.env,
			value,
			to: {
				source: 'token-response',
				...input.to,
				...(input.to.saveHosts
					? { saveHosts: echoes ? [] : input.to.saveHosts }
					: {}),
			},
			...(field === 'access_token'
				? { audienceHosts: audienceHostsFor(value, input) }
				: {}),
			// A refresh token outlives the access token; keep it for the max.
			expiresInSeconds:
				field === 'refresh_token'
					? null
					: Number.isFinite(expiresIn)
						? expiresIn
						: null,
		})
	}
	return next
}

/**
 * An endpoint that echoes the request could hand back a filled secret dressed
 * as a JWT naming any audience. Such a token keeps only `domains`. A filled
 * Basic credential is also checked for its decoded password. Decoded JWT
 * claims are not checked: real tokens carry the client id (Entra `appid`),
 * and an approved host that re-encodes a secret already holds it.
 */
function audienceHostsFor(
	token: string,
	input: { to: SealedTokenBinding; filledValues?: ReadonlyArray<string> },
) {
	if (repeatsFilledValue(token, input.filledValues)) return []
	return sealedTokenAudienceHosts(token, input.to.domains)
}

function repeatsFilledValue(
	token: string,
	filledValues: ReadonlyArray<string> = [],
) {
	return filledValues
		.flatMap((value) => [value, ...basicAuthPassword(value)])
		.some((value) => value && token.includes(value))
}

function basicAuthPassword(value: string) {
	const encoded = value.replace(/^basic\s+/i, '')
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return []
	let decoded: string
	try {
		decoded = atob(encoded)
	} catch {
		return []
	}
	const colon = decoded.indexOf(':')
	return colon < 0 ? [] : [decoded.slice(colon + 1)]
}

const maxSealedResponseBytes = 1024 * 1024

/**
 * Seals the token fields of a JSON response to a credential-bearing
 * request (a token endpoint). Other responses pass through unchanged.
 */
export async function sealTokenResponse(input: {
	env: SealedTokenEnv
	response: Response
	requestUrl: string
	/** Stored secrets the request was filled with; the token may go to their hosts. */
	mintedWith?: ReadonlyArray<SealedTokenMinter>
	/** Credential values filled into the request. */
	filledValues?: ReadonlyArray<string>
	org: string
	binding: string | null
}) {
	const { response } = input
	const contentType = response.headers.get('content-type') ?? ''
	if (!/\bjson\b/i.test(contentType) || !response.body) return response
	const domain = sealedTokenDomainForUrl(input.requestUrl)
	if (!domain) return response
	const rebuilt = (body: BodyInit) => {
		const headers = new Headers(response.headers)
		headers.delete('content-length')
		headers.delete('content-encoding')
		return withLanding(
			new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			}),
			{ url: response.url, redirected: response.redirected },
		)
	}
	const length = Number(response.headers.get('content-length'))
	if (Number.isFinite(length) && length > maxSealedResponseBytes) {
		return rebuilt(refuseTokenFields(response.body))
	}
	const head = await readUpTo(response.body, maxSealedResponseBytes)
	if (head.rest) return rebuilt(refuseTokenFields(head.rest))
	const text = new TextDecoder().decode(head.bytes)
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return rebuilt(text)
	}
	const mintedWith = input.mintedWith ?? []
	const approvedHosts = mintedWith.flatMap((minter) => minter.hosts)
	const sealed = await sealTokenFields({
		env: input.env,
		payload: parsed,
		to: {
			org: input.org,
			binding: input.binding,
			domains: [domain],
			saveHosts: [
				new URL(input.requestUrl).hostname.toLowerCase(),
				...approvedHosts.filter((host) => !host.startsWith('*.')),
			],
			...(mintedWith.length > 0 ? { mintedWith } : {}),
		},
		filledValues: input.filledValues,
	})
	return rebuilt(sealed ? JSON.stringify(sealed) : text)
}

const tokenFieldKey = new RegExp(`"(?:${sealedTokenFields.join('|')})"`)

/**
 * A response too big to parse streams through, but fails closed if it names a
 * token field, since a token in it could not be sealed. A key split across
 * chunks is caught before its value is passed on.
 */
function refuseTokenFields(body: ReadableStream<Uint8Array>) {
	const decoder = new TextDecoder()
	let tail = ''
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const text = tail + decoder.decode(chunk, { stream: true })
				if (tokenFieldKey.test(text)) {
					controller.error(
						new SecretPlacementError(
							'A credential-filled JSON response over 1 MiB names a token field, so Kody refused it rather than return an unsealed token.',
							sealedTokenSlot,
						),
					)
					return
				}
				tail = text.slice(-32)
				controller.enqueue(chunk)
			},
		}),
	)
}

async function readUpTo(body: ReadableStream<Uint8Array>, limit: number) {
	const reader = body.getReader()
	const chunks: Array<Uint8Array> = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		size += value.byteLength
		if (size > limit) {
			// Too big to be a token response: replay what was read, then stream on.
			const rest = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk)
				},
				async pull(controller) {
					const next = await reader.read()
					if (next.done) controller.close()
					else controller.enqueue(next.value)
				},
				cancel(reason) {
					return reader.cancel(reason)
				},
			})
			return { bytes: null, rest }
		}
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { bytes, rest: null }
}

/**
 * The sealed-token name in `secretSet`'s `sealed_token` input: the
 * `{{integration-token:kody-sealed.…}}` placeholder code received, or the bare
 * name. Null when the text is neither.
 */
export function sealedTokenNameFromInput(text: string) {
	const trimmed = text.trim()
	const name =
		/^\{\{integration-token:([^{}]+)\}\}$/.exec(trimmed)?.[1] ?? trimmed
	return isSealedTokenName(name) && !/\s/.test(name) ? name : null
}

/** True when a plain secret value is (or holds) a sealed token. */
export function containsSealedToken(value: string) {
	return value.includes(sealedTokenNamePrefix)
}

export const sealedTokenValueRefusal =
	'This value is a sealed token (kody-sealed.…), not the token itself, so saving it as text would store a placeholder that only works in this run. Pass it as secretSet({ name, scope: "user", sealed_token }) instead: Kody opens it and saves the real token, which code never sees.'

/** Package runtimes cannot create user secrets, so they get no `sealed_token` path. */
export const packageSealedTokenRefusal =
	'Package code cannot keep a sealed token (kody-sealed.…) across runs. To reuse an access token minted from a refresh token, the owner stores the refresh token as a login credential (kind "login" with login_exchange) and the package uses it through credential(key), declared in kody.credentials: Kody runs the token request and caches the access token. Otherwise, use the sealed token only in this run. See https://kody.codes/docs/credentials#login'

function refuseSave(message: string): never {
	throw new McpCallerError(message)
}

/**
 * Opens a sealed token so `secretSet` can save it as a Key. Refuses what a
 * gateway fill refuses (another org, another run, expiry), a signed JWT, and
 * a token that repeats a credential filled into the request that minted it.
 * Returns the exact hosts the saved Key may be sent to: the token endpoint's
 * host, the filled credentials' exact approved hosts, and its audience hosts.
 */
export async function openSealedTokenForSave(input: OpenSealedTokenInput) {
	const payload = await openSealedPayload(input, refuseSave)
	if (payload.src === 'jwt-sign') {
		refuseSave(
			'A signed JWT cannot be saved as a secret. Sign a new one with secretJwtSign when you need it.',
		)
	}
	if (!payload.save) {
		refuseSave(
			'This sealed token cannot be saved; it was not minted by a token endpoint call in a run that can save it. Mint a new one in this run.',
		)
	}
	if (payload.save.length === 0) {
		refuseSave(
			'This sealed token repeats a credential sent with the request that minted it, so Kody will not save it as a new secret.',
		)
	}
	return {
		value: payload.v,
		hosts: [...new Set([...payload.save, ...(payload.aud ?? [])])],
	}
}
