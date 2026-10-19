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
	return null
}
