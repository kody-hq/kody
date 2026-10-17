import { readFileSync } from 'node:fs'
const sensitiveKey =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|cf-access-client-id|cf-access-client-secret|cf-access-jwt-assertion)$/i
const headerContainer =
	/^(?:requestHeaders|responseHeaders|headers|extraHeaders|cookies)$/i

export function readEdgeAuth(value = process.env.EDGE_ACCESS_HEADERS_JSON) {
	if (value === undefined && process.env.EDGE_ACCESS_HEADERS_FILE)
		value = readFileSync(process.env.EDGE_ACCESS_HEADERS_FILE, 'utf8')
	let parsed
	try {
		parsed = JSON.parse(value || '{}')
	} catch {
		throw new Error('Access header configuration is not valid JSON')
	}
	const entries = Object.entries(parsed)
	return new Map(
		entries.map(([origin, headers]) => {
			const url = new URL(origin)
			if (url.protocol !== 'https:' || url.origin !== origin)
				throw new Error('Access configuration keys must be exact HTTPS origins')
			if (!headers || Array.isArray(headers) || typeof headers !== 'object')
				throw new Error('Access headers must be objects')
			for (const [name, secret] of Object.entries(headers)) {
				if (
					!/^cf-access-client-(?:id|secret)$/i.test(name) ||
					typeof secret !== 'string' ||
					!secret ||
					/[\r\n]/.test(secret)
				)
					throw new Error(
						'Only valid Cloudflare Access service-token headers are supported',
					)
			}
			return [origin, headers]
		}),
	)
}

export function requestHeadersFor(url, incoming, auth) {
	const headers = Object.fromEntries(
		Object.entries(incoming).filter(([key]) => !sensitiveKey.test(key)),
	)
	return { ...headers, ...auth.get(new URL(url).origin) }
}

export function makeSanitizer(auth) {
	const secrets = [...auth.values()]
		.flatMap(Object.values)
		.sort((a, b) => b.length - a.length)
	const text = (value) =>
		secrets.reduce(
			(result, secret) => result.split(secret).join('[REDACTED]'),
			value,
		)
	function sanitize(value) {
		if (typeof value === 'string') return text(value)
		if (Array.isArray(value)) return value.map(sanitize)
		if (
			value &&
			typeof value === 'object' &&
			sensitiveKey.test(value.name ?? '')
		)
			return { name: value.name, value: '[REDACTED]' }
		if (value && typeof value === 'object')
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					sensitiveKey.test(key) || headerContainer.test(key)
						? '[REDACTED HEADERS]'
						: sanitize(item),
				]),
			)
		return value
	}
	return sanitize
}

export async function installEdgeAuth(page, auth) {
	await page.setRequestInterception(true)
	page.on('request', (request) => {
		if (request.isInterceptResolutionHandled()) return
		void request
			.continue({
				headers: requestHeadersFor(request.url(), request.headers(), auth),
			})
			.catch(() => {})
	})
}

export function deliveryHeaders(headers) {
	const allowed = [
		'content-type',
		'content-encoding',
		'content-length',
		'cache-control',
		'cf-cache-status',
		'x-kody-cache',
		'age',
		'vary',
		'server-timing',
		'cf-ray',
	]
	return Object.fromEntries(
		allowed
			.filter((key) => headers[key] !== undefined)
			.map((key) => [key, headers[key]]),
	)
}
