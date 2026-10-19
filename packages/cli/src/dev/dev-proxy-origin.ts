/**
 * Trusted public origin for `kody dev` → workerd proxying.
 *
 * request.url must come from the CLI's listen origin (plus mount-stripped path),
 * never from a client-supplied Host (DNS rebinding) or the internal workerd
 * port. Forwarding headers are overwritten the same way.
 */

import { type IncomingHttpHeaders } from 'node:http'
import { runSecretHeader } from '../local-runtime-source.js'
import { devRequestIdHeader } from './dev-protocol.js'

/** Proxy-only: absolute public URL for this request (never trust the client). */
export const devPublicUrlHeader = 'x-kody-dev-public-url'

const forwardingHeaderNames = [
	'forwarded',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-forwarded-proto',
	'x-forwarded-port',
	'x-forwarded-prefix',
	'x-real-ip',
] as const

export function normalizeHostHeader(value: string | undefined): string | null {
	if (!value) return null
	const first = value.split(',')[0]?.trim().toLowerCase() ?? ''
	if (!first) return null
	return first
}

/**
 * Loopback Host aliases for the same port (browsers may send localhost while
 * the proxy listens on 127.0.0.1, and vice versa).
 */
export function defaultLoopbackHostAliases(trustedHost: string): Array<string> {
	const parsed = splitHostPort(trustedHost)
	if (!parsed) return []
	const { hostname, portSuffix } = parsed
	if (!isLoopbackHostname(hostname)) return []
	const aliases = new Set<string>()
	for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
		if (name === hostname) continue
		aliases.add(`${name}${portSuffix}`)
	}
	return [...aliases]
}

export function isAllowedDevHost(input: {
	incomingHost: string | undefined
	trustedHost: string
	aliases?: ReadonlyArray<string>
}): boolean {
	const incoming = normalizeHostHeader(input.incomingHost)
	if (!incoming) return false
	const allowed = new Set<string>([
		normalizeHostHeader(input.trustedHost)!,
		...defaultLoopbackHostAliases(input.trustedHost).map((alias) =>
			normalizeHostHeader(alias)!,
		),
		...(input.aliases ?? [])
			.map((alias) => normalizeHostHeader(alias))
			.filter((alias): alias is string => Boolean(alias)),
	])
	return allowed.has(incoming)
}

export function buildTrustedDevPublicUrl(input: {
	hostedUrl: string
	restPath: string
	search: string
}): string {
	// Assign pathname/search on the hosted origin. `new URL(restPath, base)`
	// treats a leading `//` as a new authority (SSRF via mount-stripped paths).
	const url = new URL(input.hostedUrl)
	url.pathname = input.restPath
	url.search = input.search
	return url.href
}

/**
 * Build a same-origin (or loopback workerd) URL without letting `restPath`
 * rewrite the authority. Same `//` hazard as {@link buildTrustedDevPublicUrl}.
 */
export function buildTrustedDevForwardUrl(input: {
	baseUrl: string
	restPath: string
	search: string
}): string {
	const url = new URL(input.baseUrl)
	url.pathname = input.restPath
	url.search = input.search
	return url.href
}

export function trustedDevHostFromHostedUrl(hostedUrl: string): string {
	const url = new URL(hostedUrl)
	return url.host
}

/**
 * Headers for the workerd hop: trusted Host + public URL, run secret, request
 * id; strip client forwarding / spoofed kody-dev headers.
 */
export function buildDevProxyUpstreamHeaders(input: {
	incoming: IncomingHttpHeaders
	trustedHost: string
	publicUrl: string
	runSecret: string
	requestId: string
}): Record<string, string | number | string[] | undefined> {
	const headers: Record<string, string | number | string[] | undefined> = {
		...input.incoming,
	}
	for (const name of forwardingHeaderNames) {
		delete headers[name]
	}
	for (const key of Object.keys(headers)) {
		const lower = key.toLowerCase()
		if (lower.startsWith('x-kody-dev-') || lower === runSecretHeader) {
			delete headers[key]
		}
	}
	headers.host = input.trustedHost
	headers[devPublicUrlHeader] = input.publicUrl
	headers[runSecretHeader] = input.runSecret
	headers[devRequestIdHeader] = input.requestId
	return headers
}

function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
	return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function splitHostPort(
	hostHeader: string,
): { hostname: string; portSuffix: string } | null {
	const normalized = normalizeHostHeader(hostHeader)
	if (!normalized) return null
	if (normalized.startsWith('[')) {
		const end = normalized.indexOf(']')
		if (end === -1) return null
		const hostname = normalized.slice(0, end + 1)
		const rest = normalized.slice(end + 1)
		const portSuffix = rest.startsWith(':') ? rest : ''
		return { hostname, portSuffix }
	}
	const colon = normalized.lastIndexOf(':')
	if (colon === -1) return { hostname: normalized, portSuffix: '' }
	return {
		hostname: normalized.slice(0, colon),
		portSuffix: normalized.slice(colon),
	}
}
