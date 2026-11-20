import { isPublicFetchHostname } from '#mcp/events/ssrf.ts'

/**
 * Credential-bearing OAuth endpoints (device authorization + token exchange)
 * must use HTTPS in production. Plain HTTP is only allowed for loopback hosts
 * so local mocks and wrangler/dev targets keep working.
 */

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.trim().toLowerCase()
	return loopbackHostnames.has(normalized) || normalized.endsWith('.localhost')
}

/**
 * True when `raw` is an absolute http(s) URL that may carry client credentials:
 * https always, http only for loopback / `*.localhost`.
 */
export function isSecureCredentialUrl(raw: string): boolean {
	try {
		const url = new URL(raw)
		if (url.protocol === 'https:') return true
		return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
	} catch {
		return false
	}
}

/**
 * True when a credential endpoint may be fetched: {@link isSecureCredentialUrl}
 * and a loopback or public host, never a private, link-local, or reserved IP
 * literal. Checked on save and before each token request, not when reading
 * stored rows, so a legacy row still lists.
 * Permanent: stored data or clients from before this change still exist.
 */
export function isPublicCredentialEndpoint(raw: string): boolean {
	if (!isSecureCredentialUrl(raw)) return false
	const hostname = new URL(raw).hostname.replace(/\.$/, '')
	return isLoopbackHostname(hostname) || isPublicFetchHostname(hostname)
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
		return `${label} must use https (http is only allowed for localhost).`
	}
	if (!isPublicCredentialEndpoint(trimmed)) {
		return `${label} must not target a private, link-local, or reserved address.`
	}
	return null
}
