import { isPublicFetchHostname } from '#mcp/events/ssrf.ts'

/**
 * Credential-bearing OAuth endpoints (device authorization + token exchange)
 * must use HTTPS and a public host in production. Loopback hosts (http or
 * https) stay allowed so local mocks and wrangler/dev targets keep working.
 */

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase()
	return loopbackHostnames.has(normalized) || normalized.endsWith('.localhost')
}

/**
 * True when `raw` is an absolute http(s) URL that may carry client credentials:
 * https to a public host, or http(s) to loopback / `*.localhost`. Private,
 * link-local, and reserved IP literals are refused.
 */
export function isSecureCredentialUrl(raw: string): boolean {
	try {
		const url = new URL(raw)
		if (isLoopbackHostname(url.hostname)) {
			return url.protocol === 'https:' || url.protocol === 'http:'
		}
		return url.protocol === 'https:' && isPublicFetchHostname(url.hostname)
	} catch {
		return false
	}
}

export function assertSecureCredentialUrl(
	raw: string,
	label: string,
): string | null {
	const trimmed = raw.trim()
	if (!trimmed) {
		return `${label} is required.`
	}
	if (!isSecureCredentialUrl(trimmed)) {
		return `${label} must use https and a public host (http is only allowed for localhost).`
	}
	return null
}
