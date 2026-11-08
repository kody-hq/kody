/**
 * `kody dev --host`: which address the dev proxy listens on. Loopback is the
 * default. Binding anything else (0.0.0.0, ::, a LAN IP) exposes the app to
 * other devices, so the Host allowlist grows to this machine's own interface
 * addresses only. The workerd, bridge, and mock ports stay on 127.0.0.1.
 */

import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { StructuredCliError } from '../structured-error.js'
import type { KodyTarget } from '../target.js'

export const defaultDevHost = '127.0.0.1'

type InterfaceMap = NodeJS.Dict<Array<NetworkInterfaceInfo>>

export function parseDevHost(raw: string): string {
	const trimmed = raw.trim()
	const unbracketed =
		trimmed.startsWith('[') && trimmed.endsWith(']')
			? trimmed.slice(1, -1)
			: trimmed
	const lower = unbracketed.toLowerCase()
	if (lower === 'localhost') return 'localhost'
	const family = isIP(lower)
	if (family === 4) return lower
	if (family === 6 && !lower.includes('%')) return lower
	throw new StructuredCliError({
		code: 'invalid_host',
		message: `--host must be an IP address to listen on, like 127.0.0.1, 0.0.0.0, ::, or a LAN IP such as 192.168.1.20 (got "${raw}").`,
		fix: 'Pass --host 0.0.0.0 to reach kody dev from other devices on your network, or omit --host to stay on 127.0.0.1.',
	})
}

export function isLoopbackDevHost(host: string): boolean {
	const value = host.replace(/^\[|\]$/g, '').toLowerCase()
	if (value === 'localhost' || value === '::1') return true
	const v4 = value.startsWith('::ffff:') ? value.slice(7) : value
	return isIP(v4) === 4 && v4.startsWith('127.')
}

function isWildcardDevHost(host: string): boolean {
	return host === '0.0.0.0' || host === '::'
}

/** `host` as it appears in a URL authority (IPv6 in brackets). */
function formatUrlHost(host: string): string {
	return isIP(host) === 6 ? `[${host}]` : host
}

/**
 * This machine's non-internal addresses a LAN device could use to reach a
 * server bound to `bindHost`, most likely home/office LAN first. Link-local
 * IPv6 (needs a zone id) is skipped.
 */
export function devLanAddresses(
	bindHost: string,
	interfaces: InterfaceMap = networkInterfaces(),
): Array<string> {
	if (isLoopbackDevHost(bindHost)) return []
	if (!isWildcardDevHost(bindHost)) return [bindHost]
	const includeV6 = bindHost === '::'
	const addresses = new Set<string>()
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.internal) continue
			const address = entry.address.toLowerCase()
			if (entry.family === 'IPv4') {
				addresses.add(address)
			} else if (includeV6 && !address.startsWith('fe80:')) {
				addresses.add(address)
			}
		}
	}
	return [...addresses].sort((a, b) => lanRank(a) - lanRank(b))
}

function lanRank(address: string): number {
	if (address.startsWith('192.168.')) return 0
	if (address.startsWith('10.')) return 1
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2
	if (isIP(address) === 4) return 3
	return 4
}

export type DevListenPlan = {
	/**
	 * Primary public origin (packageContext.hostedUrl, printed URL). For a
	 * wildcard bind this is the first LAN address, so client bundle URLs work
	 * on other devices too.
	 */
	hostedUrl: string
	/** Origin this machine uses to reach the server (attach registry, fetch). */
	localUrl: string
	/** Extra `host:port` values the Host guard accepts (beyond hostedUrl's). */
	extraAllowedHosts: () => Array<string>
	/** URLs to open from other devices (empty for loopback binds). */
	networkUrls: Array<string>
}

export function planDevListen(input: {
	bindHost: string
	port: number
	interfaces?: () => InterfaceMap
}): DevListenPlan {
	const { bindHost, port } = input
	const readInterfaces = input.interfaces ?? networkInterfaces
	const origin = (host: string) => `http://${formatUrlHost(host)}:${port}`
	if (isLoopbackDevHost(bindHost)) {
		const url = origin(bindHost)
		return {
			hostedUrl: url,
			localUrl: url,
			extraAllowedHosts: () => [],
			networkUrls: [],
		}
	}
	if (!isWildcardDevHost(bindHost)) {
		const url = origin(bindHost)
		return {
			hostedUrl: url,
			localUrl: url,
			extraAllowedHosts: () => [],
			networkUrls: [url],
		}
	}
	const localUrl = origin(bindHost === '::' ? '::1' : '127.0.0.1')
	const lan = devLanAddresses(bindHost, readInterfaces())
	return {
		hostedUrl: lan[0] ? origin(lan[0]) : localUrl,
		localUrl,
		// Re-read per request: Wi-Fi changes and DHCP renewals move addresses.
		extraAllowedHosts: () => [
			`127.0.0.1:${port}`,
			`localhost:${port}`,
			`[::1]:${port}`,
			...devLanAddresses(bindHost, readInterfaces()).map(
				(address) => `${formatUrlHost(address)}:${port}`,
			),
		],
		networkUrls: lan.map(origin),
	}
}

/**
 * Non-loopback binds with `--target prod` let any device on the network act
 * as you, so they need `--expose-prod` on top of `--host`.
 */
export function assertDevHostAllowed(input: {
	bindHost: string
	target: KodyTarget
	exposeProd: boolean
}): void {
	if (isLoopbackDevHost(input.bindHost)) return
	if (input.target !== 'prod' || input.exposeProd) return
	throw new StructuredCliError({
		code: 'dev_host_prod_refused',
		target: input.target,
		message: `Refusing --host ${input.bindHost} with --target prod: anyone on the network who can reach this port could use the app with your real Kody credentials.`,
		fix: 'Use the default --target mock (fake credentials, scratch storage) for device testing. If you really need prod data on the network, add --expose-prod.',
	})
}

export function devHostExposureWarning(input: {
	bindHost: string
	target: KodyTarget
}): string | null {
	if (isLoopbackDevHost(input.bindHost)) return null
	const credentials =
		input.target === 'prod'
			? 'With --target prod it acts with your real Kody credentials, storage, and secrets.'
			: 'It runs on --target mock (fake credentials, scratch storage); with --target prod it would act with your real Kody credentials.'
	return (
		`warning: kody dev is listening on ${input.bindHost}, so it is exposed to every device on your network. ` +
		`Anyone who can reach this port can use the app. ${credentials} ` +
		'Use --host only on networks you trust, and stop kody dev when you are done.\n'
	)
}
