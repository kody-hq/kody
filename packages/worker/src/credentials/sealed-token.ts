/**
 * Sealed tokens (ADR 0068, 2026-10-27 amendment): a token Kody derived for
 * code (an OAuth access or refresh token, an id token, a signed JWT) comes
 * back as an integration-token placeholder whose name is the token encrypted
 * by the host. Code can pass it into a fetch header or body; the gateway
 * opens it there and fills the value. Code never holds the value.
 *
 * A sealed token is bound to its org, the run that received it (when the
 * run has a binding), the registrable domains it may be sent to, and an
 * expiry.
 */
import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { getDomain } from 'tldts'
import { z } from 'zod'
import { withLanding } from '#mcp/secrets/echo-redaction.ts'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import { buildIntegrationTokenPlaceholder } from '#mcp/secrets/placeholders.ts'

export const sealedTokenNamePrefix = 'kody-sealed.'
/** A `domains` entry that lets a sealed token fill on any host. */
export const anySealedTokenDomain = '*'
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
})

type SealedTokenEnv = Pick<Env, 'SECRET_STORE_KEY'>

export type SealedTokenBinding = {
	org: string
	binding: string | null
	domains: ReadonlyArray<string>
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
	now?: number
}) {
	const now = input.now ?? Date.now()
	const lifetimeMs =
		typeof input.expiresInSeconds === 'number' &&
		Number.isFinite(input.expiresInSeconds)
			? Math.min(Math.max(input.expiresInSeconds, 0) * 1000, maxLifetimeMs)
			: maxLifetimeMs
	const payload: z.infer<typeof sealedPayloadSchema> = {
		v: input.value,
		org: input.to.org,
		binding: input.to.binding,
		domains: [...new Set(input.to.domains)],
		exp: now + lifetimeMs,
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

/**
 * Opens a sealed token for a gateway fill. Refuses another org, another
 * run, an expired token, a host outside its domains, and the URL.
 */
export async function openSealedToken(input: {
	env: SealedTokenEnv
	name: string
	org: string
	binding: string | null
	requestHost: string
	parts: ReadonlyArray<string>
	now?: number
}) {
	const encoded = input.name.slice(sealedTokenNamePrefix.length)
	const [ivText, sealedText, extra] = encoded.split('.')
	if (!ivText || !sealedText || extra !== undefined) {
		refuse('This sealed token is malformed.')
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
		refuse('This sealed token was not issued by this Kody.')
	}
	if (payload.org !== input.org) {
		refuse('This sealed token belongs to another account.')
	}
	if (payload.binding && payload.binding !== input.binding) {
		refuse(
			'This sealed token belongs to another run. Mint a new one in this run.',
		)
	}
	if ((input.now ?? Date.now()) >= payload.exp) {
		refuse('This sealed token expired. Mint a new one.')
	}
	const host = input.requestHost.toLowerCase()
	if (
		!payload.domains.some(
			(domain) =>
				domain === anySealedTokenDomain ||
				host === domain ||
				host.endsWith(`.${domain}`),
		)
	) {
		refuse(
			`A sealed token may only be sent to ${payload.domains.join(', ')}, not ${host}.`,
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
	return payload.v
}

/**
 * Replaces the token fields of a JSON object with sealed tokens. Returns
 * null when there is nothing to seal.
 */
export async function sealTokenFields(input: {
	env: SealedTokenEnv
	payload: unknown
	to: SealedTokenBinding
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
		next[field] = await sealToken({
			env: input.env,
			value,
			to: input.to,
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

const maxSealedResponseBytes = 1024 * 1024

/**
 * Seals the token fields of a JSON response to a credential-bearing
 * request (a token endpoint). Other responses pass through unchanged.
 */
export async function sealTokenResponse(input: {
	env: SealedTokenEnv
	response: Response
	requestUrl: string
	/** The filled credentials' approved hosts; the token may also go there. */
	approvedHosts?: ReadonlyArray<string>
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
	const sealed = await sealTokenFields({
		env: input.env,
		payload: parsed,
		to: {
			org: input.org,
			binding: input.binding,
			domains: [domain, ...approvedHostDomains(input.approvedHosts ?? [])],
		},
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

function approvedHostDomains(hosts: ReadonlyArray<string>) {
	return hosts.flatMap((host) => {
		const domain = sealedTokenDomainForUrl(
			`https://${host.replace(/^\*\./, '')}`,
		)
		return domain ? [domain] : []
	})
}
