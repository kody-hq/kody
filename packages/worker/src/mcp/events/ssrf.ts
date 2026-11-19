import { mcpEventRequestTimeoutMs } from './constants.ts'

/**
 * Callback URL guard for MCP event webhooks (verification + delivery).
 *
 * The draft asks servers to resolve the hostname, reject non-global
 * addresses, then connect to the validated IP (preserving SNI) so DNS
 * rebinding cannot swap the target. Cloudflare Workers expose neither a DNS
 * resolver nor a way to pin `fetch` to a resolved IP, so that exact
 * check-then-connect is not implementable here. What this module does
 * instead, on every outbound request (not only at subscribe time):
 *
 * - HTTPS only, no credentials, no fragment.
 * - Reject special-use / non-public hostnames (`localhost`, `*.local`,
 *   `*.internal`, single-label names, reserved TLDs).
 * - Reject IP-literal hosts outside globally routable unicast space (IANA
 *   IPv4/IPv6 special-purpose registries: loopback, RFC 1918, CGNAT,
 *   link-local / metadata 169.254.0.0/16, ULA, mapped, NAT64, docs, ...).
 * - `redirect: 'error'` and a hard timeout.
 *
 * Residual risk (accepted, see ADR 0059): a public hostname whose DNS answers
 * a private address. Worker egress runs on Cloudflare's network with
 * `global_fetch_strictly_public`, which has no route into private networks
 * unless a binding (Tunnel / VPC) is configured, and none is used here.
 */

export class McpEventCallbackUrlError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'McpEventCallbackUrlError'
	}
}

const blockedHostnames = new Set(['localhost', 'localhost.localdomain'])

const blockedHostnameSuffixes = [
	'.localhost',
	'.local',
	'.internal',
	'.home.arpa',
	'.lan',
	'.localdomain',
	'.test',
	'.example',
	'.invalid',
	'.onion',
	'.arpa',
]

export function assertMcpEventCallbackUrl(value: string): URL {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new McpEventCallbackUrlError('delivery.url must be an absolute URL.')
	}
	if (url.protocol !== 'https:') {
		throw new McpEventCallbackUrlError('delivery.url must use https.')
	}
	if (url.username || url.password) {
		throw new McpEventCallbackUrlError(
			'delivery.url must not include credentials.',
		)
	}
	if (url.hash) {
		throw new McpEventCallbackUrlError(
			'delivery.url must not include a fragment.',
		)
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
	if (!hostname) {
		throw new McpEventCallbackUrlError('delivery.url must include a host.')
	}
	if (hostname.startsWith('[')) {
		if (!isPublicIpv6(hostname.slice(1, -1))) {
			throw new McpEventCallbackUrlError(
				'delivery.url must not target a private, loopback, link-local, or reserved IPv6 address.',
			)
		}
		return url
	}
	const ipv4 = parseIpv4(hostname)
	if (ipv4) {
		if (!isPublicIpv4(ipv4)) {
			throw new McpEventCallbackUrlError(
				'delivery.url must not target a private, loopback, link-local, or reserved IPv4 address.',
			)
		}
		return url
	}
	if (
		blockedHostnames.has(hostname) ||
		blockedHostnameSuffixes.some((suffix) => hostname.endsWith(suffix))
	) {
		throw new McpEventCallbackUrlError(
			`delivery.url host "${hostname}" is not a public hostname.`,
		)
	}
	if (!hostname.includes('.')) {
		throw new McpEventCallbackUrlError(
			`delivery.url host "${hostname}" must be a fully qualified public hostname.`,
		)
	}
	return url
}

/**
 * The only way MCP event code reaches a callback: re-validates the URL on
 * every call (delivery-time, not just subscribe-time), never follows
 * redirects, and bounds the request.
 */
export async function fetchMcpEventCallback(
	url: string,
	init: { headers: Record<string, string>; body: string },
): Promise<Response> {
	const validated = assertMcpEventCallbackUrl(url)
	return await fetch(validated, {
		method: 'POST',
		headers: init.headers,
		body: init.body,
		redirect: 'error',
		signal: AbortSignal.timeout(mcpEventRequestTimeoutMs),
	})
}

/**
 * False for loopback names and IP-literal hosts outside globally routable
 * unicast space. Takes `URL.hostname`, which already normalizes decimal,
 * octal, and hex IPv4 forms. Shared by every outbound fetch guard.
 */
export function isPublicFetchHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '')
	if (host.startsWith('[')) return isPublicIpv6(host.slice(1, -1))
	const ipv4 = parseIpv4(host)
	if (ipv4) return isPublicIpv4(ipv4)
	return !blockedHostnames.has(host) && !host.endsWith('.localhost')
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
	// WHATWG URL already normalizes decimal/octal/hex IPv4 forms to dotted quad.
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
	if (!match) return null
	const octets = match.slice(1).map(Number)
	if (octets.some((octet) => octet > 255)) return null
	return octets as [number, number, number, number]
}

const nonPublicIpv4Ranges: ReadonlyArray<readonly [string, number]> = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
]

function ipv4ToNumber(octets: ReadonlyArray<number>) {
	return (
		((octets[0]! << 24) >>> 0) +
		(octets[1]! << 16) +
		(octets[2]! << 8) +
		octets[3]!
	)
}

export function isPublicIpv4(octets: ReadonlyArray<number>): boolean {
	const address = ipv4ToNumber(octets)
	for (const [base, prefix] of nonPublicIpv4Ranges) {
		const baseNumber = ipv4ToNumber(base.split('.').map(Number))
		const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
		if ((address & mask) >>> 0 === (baseNumber & mask) >>> 0) {
			return false
		}
	}
	return true
}

function parseIpv6Groups(part: string): Array<number> | null {
	if (part === '') return []
	const groups = part.split(':')
	if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null
	return groups.map((group) => Number.parseInt(group, 16))
}

/** Expand an IPv6 literal (no brackets) to eight 16-bit groups. */
function expandIpv6(value: string): Array<number> | null {
	if (!/^[0-9a-f:.]+$/i.test(value)) return null
	let address = value
	const embeddedIpv4Groups: Array<number> = []
	const embeddedIpv4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)
	if (embeddedIpv4) {
		const octets = parseIpv4(embeddedIpv4[1]!)
		if (!octets) return null
		address = address.slice(0, -embeddedIpv4[1]!.length)
		if (!address.endsWith(':')) return null
		if (!address.endsWith('::')) address = address.slice(0, -1)
		embeddedIpv4Groups.push(
			(octets[0] << 8) | octets[1],
			(octets[2] << 8) | octets[3],
		)
	}
	const halves = address.split('::')
	if (halves.length > 2) return null
	const left = parseIpv6Groups(halves[0]!)
	const right = parseIpv6Groups(halves[1] ?? '')
	if (!left || !right) return null
	if (halves.length === 1) {
		const groups = [...left, ...embeddedIpv4Groups]
		return groups.length === 8 ? groups : null
	}
	const tail = [...right, ...embeddedIpv4Groups]
	const missing = 8 - left.length - tail.length
	if (missing < 1) return null
	return [...left, ...Array<number>(missing).fill(0), ...tail]
}

/**
 * Only global unicast (2000::/3) is public, minus the IETF protocol block
 * (2001::/23, includes Teredo), documentation (2001:db8::/32), and 6to4
 * (2002::/16), which can tunnel to arbitrary IPv4 targets.
 */
export function isPublicIpv6(value: string): boolean {
	const groups = expandIpv6(value)
	if (!groups) return false
	const first = groups[0]!
	if ((first & 0xe000) !== 0x2000) return false
	if (first === 0x2001 && groups[1]! < 0x0200) return false
	if (first === 0x2001 && groups[1] === 0x0db8) return false
	if (first === 0x2002) return false
	return true
}
