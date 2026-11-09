import { setResponseHeader } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'

// Server route handlers for `/login/device`. Kept apart from the page loader
// so the client build drops this module with `server.handlers`.

/** Document GET: finish an approved sign-in, or keep the page refreshing. */
export async function accountDeviceSignInDocument<T>({
	request,
	next,
}: {
	request: Request
	next: () => T
}) {
	const [{ setAuthSessionSecret }, { handleAccountDeviceSignInDocument }] =
		await Promise.all([
			import('../../src/app/auth-session.ts'),
			import('../../src/app/account-device-sign-in.ts'),
		])
	const env = getStartRequestEnv()
	setAuthSessionSecret(env.COOKIE_SECRET)
	const result = await handleAccountDeviceSignInDocument({ request, env })
	if (result instanceof Response) return result
	setResponseHeader('Cache-Control', 'private, no-store')
	setResponseHeader('Referrer-Policy', 'no-referrer')
	if (result.refreshSeconds !== null) {
		// A plain HTTP refresh keeps checking without any page JavaScript.
		setResponseHeader('Refresh', String(result.refreshSeconds))
	}
	return next()
}

/** `POST`: ask for a code from the "Sign in on another device" form. */
export async function accountDeviceSignInPost({
	request,
}: {
	request: Request
}) {
	const { startAccountDeviceSignIn } =
		await import('../../src/app/account-device-sign-in.ts')
	return startAccountDeviceSignIn({ request, env: getStartRequestEnv() })
}

export function rejectAccountDeviceMethod() {
	return new Response('Method not allowed.', {
		status: 405,
		headers: { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' },
	})
}
