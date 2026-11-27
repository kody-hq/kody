/**
 * Where an app lives, from the address a person or agent has in hand: an
 * `@org/app` name or the app's hosted URL. The address names the owning org,
 * so a lookup never depends on the org the caller's connection is bound to.
 */
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveVerifiedCustomHostnameIfEnabled } from '#app/package-app-origin.ts'
import { parsePackageAppRequestHost } from '#worker/app-base-url.ts'
import { hasProfilePackageApp } from '#worker/package-app-profile-host.ts'
import {
	parsePackageAppPath,
	parsePackageAppSubdomainPath,
} from '#worker/package-runtime/package-app-serve.ts'

export type AppAddress = {
	ownerHandle: string
	appSlug: string
	/** Path and query after the app's mount, when the address carried one. */
	path: string | null
	/**
	 * Set when the address was a verified custom domain: the URL the app is
	 * mounted at there, so the app sees the host the caller named.
	 */
	customMount?: { baseUrl: string; mount: 'custom-hostname' | 'user-subdomain' }
}

const appNamePattern = /^@([^/\s?#]+)\/([^/\s?#]+)([/?#].*)?$/

function invalidAddress(address: string) {
	return new McpCallerError(
		`"${address}" is not an app address. Pass the app as @org/app or its hosted URL (appList returns both).`,
	)
}

function withSearch(restPath: string, url: URL) {
	const path = `${restPath}${url.search}`
	return path === '/' ? null : path
}

export async function resolveAppAddress(input: {
	env: Env
	address: string
	/** The Kody origin the caller reached, whose package pages name apps too. */
	appBaseUrl: string
}): Promise<AppAddress> {
	const address = input.address.trim()
	const named = appNamePattern.exec(address)
	if (named) {
		const [, ownerHandle = '', appSlug = '', rest = ''] = named
		return {
			ownerHandle,
			appSlug,
			path: rest ? (rest.startsWith('/') ? rest : `/${rest}`) : null,
		}
	}
	let url: URL
	try {
		url = new URL(address)
	} catch {
		throw invalidAddress(address)
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw invalidAddress(address)
	}
	const { env } = input
	const host = parsePackageAppRequestHost({ env, url })
	if (host?.kind === 'app-subdomain') {
		return {
			ownerHandle: host.username,
			appSlug: host.kodyId,
			path: withSearch(url.pathname, url),
		}
	}
	if (host?.kind === 'user-subdomain') {
		// A profile app owns every path on its owner's bare host.
		if (await hasProfilePackageApp({ env, username: host.username })) {
			return {
				ownerHandle: host.username,
				appSlug: host.username,
				path: withSearch(url.pathname, url),
			}
		}
		const parsed = parsePackageAppSubdomainPath({
			pathname: url.pathname,
			username: host.username,
		})
		if (!parsed) throw invalidAddress(address)
		return {
			ownerHandle: parsed.username,
			appSlug: parsed.kodyId,
			path: withSearch(parsed.restPath, url),
		}
	}
	if (!host) {
		const custom = await resolveVerifiedCustomHostnameIfEnabled(
			new Request(url),
			env,
		)
		if (custom?.bindingKind === 'org') {
			const parsed = parsePackageAppSubdomainPath({
				pathname: url.pathname,
				username: custom.username,
			})
			if (!parsed) throw invalidAddress(address)
			const mountPath = url.pathname.endsWith(parsed.restPath)
				? url.pathname.slice(0, -parsed.restPath.length)
				: url.pathname
			return {
				ownerHandle: parsed.username,
				appSlug: parsed.kodyId,
				path: withSearch(parsed.restPath, url),
				customMount: {
					baseUrl: `${url.origin}${mountPath.replace(/\/$/, '')}`,
					mount: 'user-subdomain',
				},
			}
		}
		if (custom) {
			return {
				ownerHandle: custom.username,
				appSlug: custom.kodyId,
				path: withSearch(url.pathname, url),
				customMount: { baseUrl: url.origin, mount: 'custom-hostname' },
			}
		}
	}
	// The package page and inline app paths on the Kody origin name the app too.
	const onKody =
		host?.kind === 'apex' || url.host === new URL(input.appBaseUrl).host
	const parsed = onKody ? parsePackageAppPath(url.pathname) : null
	if (parsed) {
		return {
			ownerHandle: parsed.username,
			appSlug: parsed.kodyId,
			path: withSearch(parsed.restPath, url),
		}
	}
	const page = onKody ? appNamePattern.exec(url.pathname.slice(1)) : null
	if (page) {
		return { ownerHandle: page[1] ?? '', appSlug: page[2] ?? '', path: null }
	}
	throw invalidAddress(address)
}
