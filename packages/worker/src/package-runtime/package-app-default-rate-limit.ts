import { isWebSocketUpgradeRequest } from '#worker/package-runtime/websocket-upgrade.ts'
import { wantsJson } from '#worker/utils.ts'
import { packageAppDefaultHeader } from './package-app-defaults.ts'

/**
 * Default write rate limit for every hosted package app: each visitor IP gets
 * {@link packageAppWriteRateLimit} writes (POST, PUT, PATCH, DELETE) per app
 * per window before Kody answers 429. Page loads, assets, and realtime
 * sockets are not counted. Apps that need a tighter or per-user limit call
 * `kody.appRateLimit` themselves.
 *
 * Counts live in the `PACKAGE_APP_RATE_LIMITER` binding (configured in
 * `packages/runtime-worker/wrangler.jsonc` with the same numbers). Runtimes
 * without the binding, such as local development, serve without the limit.
 */
export const packageAppWriteRateLimit = {
	maxRequests: 300,
	windowSeconds: 60,
} as const

// Bound on the runtime Worker only, so the shared Env type does not carry it.
type PackageAppRateLimitEnv = {
	PACKAGE_APP_RATE_LIMITER?: RateLimit
}

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

export function packageAppWriteRateLimitKey(input: {
	packageId: string
	ip: string
}) {
	return `package-app-write:${input.packageId}:${input.ip}`
}

/** `null` to serve, or the 429 response to send instead. */
export async function refusePackageAppWriteOverRateLimit(input: {
	request: Request
	env: object
	packageId: string
	/** Smoke tests (`appFetch` with `synthetic: true`) are not visitor traffic. */
	synthetic: boolean
}): Promise<Response | null> {
	const { request } = input
	if (input.synthetic) return null
	if (readMethods.has(request.method)) return null
	if (isWebSocketUpgradeRequest(request)) return null
	const limiter = (input.env as PackageAppRateLimitEnv).PACKAGE_APP_RATE_LIMITER
	if (!limiter) return null
	const ip = request.headers.get('CF-Connecting-IP')?.trim()
	if (!ip) return null
	const { success } = await limiter.limit({
		key: packageAppWriteRateLimitKey({ packageId: input.packageId, ip }),
	})
	if (success) return null
	const retryAfter = String(packageAppWriteRateLimit.windowSeconds)
	const message =
		'Too many requests to this app from your network. Wait a minute, then try again.'
	const headers = {
		'Cache-Control': 'no-store',
		'Retry-After': retryAfter,
		[packageAppDefaultHeader]: 'rate-limit',
	}
	if (wantsJson(request)) {
		return Response.json(
			{
				error: 'rate_limited',
				message,
				retry_after_seconds: Number(retryAfter),
			},
			{ status: 429, headers },
		)
	}
	return new Response(message, {
		status: 429,
		headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
	})
}
