import * as Sentry from '@sentry/cloudflare'
import { setResponseStatus } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'
import { verifyPublicFormProtection } from '../../src/app/public-form-protection.ts'
import { discardUnreadRequestBody } from '../../src/request-body.ts'
import {
	handleAuthorizeRequest,
	handleAuthorizeRouteException,
	tryHandleSilentOidcAuthorize,
} from '../../src/oauth-handlers.ts'

// Silent authorization can issue a code. Only document GET dispatch runs it,
// never a loader, a server-function read, or a client-side preload.
export async function oauthAuthorizeDocument<T>({
	request,
	next,
}: {
	request: Request
	next: () => T
}) {
	try {
		const response = await tryHandleSilentOidcAuthorize(
			request,
			getStartRequestEnv(),
		)
		return response ?? (await next())
	} catch (error) {
		Sentry.captureException(error)
		return handleAuthorizeRouteException(request)
	}
}

export function oauthAuthorizePost({ request }: { request: Request }) {
	return handleOAuthAuthorizePost(request, getStartRequestEnv())
}

/** Explicit bindings preserve the provider-injected helpers at transport boundaries. */
export async function handleOAuthAuthorizePost(
	request: Request,
	bindings: Env,
) {
	try {
		if (
			request.headers
				.get('Content-Type')
				?.includes('application/x-www-form-urlencoded')
		) {
			const formData = await request.clone().formData()
			if (formData.has('email') || formData.has('password')) {
				const protection = await verifyPublicFormProtection({
					env: bindings,
					request,
					body: Object.fromEntries(formData),
				})
				if (!protection.ok) {
					await discardUnreadRequestBody(request)
					return protection.response
				}
			}
		}
		return await handleAuthorizeRequest(request, bindings)
	} catch (error) {
		Sentry.captureException(error)
		return handleAuthorizeRouteException(request)
	}
}

export function rejectOAuthAuthorizeMethod() {
	return new Response('Method not allowed', {
		status: 405,
		headers: { Allow: 'GET, POST' },
	})
}

export function oauthCallbackDocument<T>({
	request,
	next,
}: {
	request: Request
	next: () => T
}) {
	const search = new URL(request.url).searchParams
	setResponseStatus(
		search.has('error') || search.has('error_description') ? 400 : 200,
	)
	return next()
}
