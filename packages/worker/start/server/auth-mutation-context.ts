import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { checkAuthRateLimit } from '#app/rate-limit.ts'
import { getRequestIp } from '#worker/audit-log.ts'

export async function publicAuthContext() {
	const request = getRequest()
	const env = getStartRequestEnv()
	setAuthSessionSecret(env.COOKIE_SECRET)
	setResponseHeader('Cache-Control', 'private, no-store')
	const limit = await checkAuthRateLimit(
		env,
		`auth:ip:${getRequestIp(request) ?? 'unknown'}`,
	)
	if (!limit.allowed) {
		setResponseHeader('Retry-After', String(limit.retryAfterSeconds ?? 60))
		throw new Error('Too many attempts. Please try again later.')
	}
	return { request, env }
}

type UnionKeys<T> = T extends T ? keyof T : never
type ResultFields<T> = {
	[K in UnionKeys<T>]?: T extends Record<K, infer V> ? V : never
}

export function publishAuthResult<
	T extends { data: unknown; status: number; headers: Headers },
>(result: T) {
	const cookies = result.headers.getSetCookie()
	if (cookies.length) setResponseHeader('Set-Cookie', cookies)
	const retry = result.headers.get('Retry-After')
	if (retry) setResponseHeader('Retry-After', retry)
	return {
		...(result.data as object),
		successful: result.status < 400,
	} as ResultFields<T['data']> & {
		successful: boolean
		ok?: boolean
		error?: string
		code?: string
		message?: string
		requiresTwoFactor?: boolean
		emailVerificationRequired?: boolean
	}
}
