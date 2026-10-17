import { setResponseHeader } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'

export async function resolvePackageAppOauth(
	request: Request,
	allowConsentSkip: boolean,
) {
	const { handlePackageAppOauthAuthorizeRequest } =
		await import('../../src/app/package-app-oauth-authorize.ts')
	return handlePackageAppOauthAuthorizeRequest(request, getStartRequestEnv(), {
		allowConsentSkip,
	})
}

/** Only the document protocol dispatch can skip consent and issue a code. */
export async function packageAppOauthAuthorizeDocument<T>({
	request,
	next,
}: {
	request: Request
	next: () => T
}) {
	const result = await resolvePackageAppOauth(request, true)
	if (result instanceof Response) return result
	setResponseHeader('Cache-Control', 'private, no-store')
	setResponseHeader('Referrer-Policy', 'no-referrer')
	return next()
}

export async function packageAppOauthAuthorizePost({
	request,
}: {
	request: Request
}) {
	const result = await resolvePackageAppOauth(request, true)
	if (result instanceof Response) return result
	throw new Error('Authorization decisions must return a protocol response')
}

export function rejectPackageAppOauthMethod() {
	return new Response('Method not allowed.', {
		status: 405,
		headers: { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' },
	})
}

export async function packageAppOauthHostAuth({
	request,
}: {
	request: Request
}) {
	const env = getStartRequestEnv()
	const { getPackageAppBaseUrl } = await import('../../src/app-base-url.ts')
	if (getPackageAppBaseUrl({ env }))
		return new Response('Not found.', { status: 404 })
	const { handlePackageAppOauthHostAuth } =
		await import('../../src/app/package-app-oauth-host-auth.ts')
	return (
		(await handlePackageAppOauthHostAuth({
			env,
			request,
			url: new URL(request.url),
		})) ?? new Response('Not found.', { status: 404 })
	)
}
