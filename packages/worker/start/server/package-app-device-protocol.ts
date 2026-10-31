import { setResponseHeader } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'

// Server route handlers for `/oauth/package-app/device`. Kept apart from the
// page loader so the client build drops this module with `server.handlers`.

/** Document GET: finish an approved sign-in, or keep the page refreshing. */
export async function packageAppDeviceSignInDocument<T>({
	request,
	next,
}: {
	request: Request
	next: () => T
}) {
	const [{ setAuthSessionSecret }, { handlePackageAppDeviceSignInDocument }] =
		await Promise.all([
			import('../../src/app/auth-session.ts'),
			import('../../src/app/package-app-device-sign-in.ts'),
		])
	const env = getStartRequestEnv()
	setAuthSessionSecret(env.COOKIE_SECRET)
	const result = await handlePackageAppDeviceSignInDocument({ request, env })
	if (result instanceof Response) return result
	setResponseHeader('Cache-Control', 'private, no-store')
	setResponseHeader('Referrer-Policy', 'no-referrer')
	if (result.pending) {
		// A plain HTTP refresh keeps checking without any page JavaScript.
		const { packageAppDeviceRefreshSeconds } =
			await import('../../src/app/package-app-device-sign-in.ts')
		setResponseHeader('Refresh', String(packageAppDeviceRefreshSeconds))
	}
	return next()
}

/** `POST`: start a sign-in from the app's sign-in page. */
export async function packageAppDeviceSignInPost({
	request,
}: {
	request: Request
}) {
	const { startPackageAppDeviceSignIn } =
		await import('../../src/app/package-app-device-sign-in.ts')
	return startPackageAppDeviceSignIn({ request, env: getStartRequestEnv() })
}

export function rejectPackageAppDeviceMethod() {
	return new Response('Method not allowed.', {
		status: 405,
		headers: { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' },
	})
}
