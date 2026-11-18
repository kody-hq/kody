import { isServerFunctionRequest } from './action-page-method.ts'
import * as Sentry from '@sentry/cloudflare'
import { setAuthSessionSecret } from '../src/app/auth-session.ts'
import { getEnv } from '../src/app/env.ts'
import { runWithRequestContext } from '../src/request-context.ts'
import { runWithDeferredWork } from '../src/deferred-work.ts'
import { wasSentryReported } from '../src/app/sentry-reported-error.ts'
import {
	renderInternalServerErrorPage,
	retryHrefFromRequest,
} from '../src/app/internal-error-page.ts'
import {
	deploySkewBuildHeader,
	normalizeDeploySkewBuildId,
} from '../universal/deploy-skew.ts'

type RenderDocument = (
	request: Request,
	env: Env,
	failure?: { status: 403 | 404 | 500 },
) => Promise<Response>

/** The same HTTP boundary is used by the origin worker and its contract tests. */
export function createHttpRequestHandler(renderDocument: RenderDocument) {
	return async function handleRequest(
		request: Request,
		env: Env,
		ctx?: Pick<ExecutionContext, 'waitUntil'>,
	) {
		const inRequest = <T>(run: () => Promise<T>) =>
			runWithDeferredWork(
				ctx ? (promise) => ctx.waitUntil(promise) : undefined,
				() => runWithRequestContext(request, run),
			)
		try {
			const bindings = getEnv(env)
			setAuthSessionSecret(bindings.COOKIE_SECRET)
			const response = inRequest(async () => {
				if (isServerFunctionRequest(request)) {
					const response = await renderDocument(request, bindings)
					// Start serializes thrown redirects after request middleware finishes.
					// Enforce RPC privacy on the final response, even when shared document
					// loaders set public caching for their canonical document redirects.
					const headers = new Headers(response.headers)
					headers.set('Cache-Control', 'private, no-store')
					// Advertise the live Worker commit so stale tabs can hard-navigate
					// instead of rendering a newer loader shape (KODY-DP).
					const buildId = normalizeDeploySkewBuildId(bindings.APP_COMMIT_SHA)
					if (buildId) headers.set(deploySkewBuildHeader, buildId)
					return new Response(response.body, {
						status: response.status,
						statusText: response.statusText,
						headers,
					})
				}
				const response = await renderDocument(request, bindings)
				const contentType = response.headers
					.get('Content-Type')
					?.split(';')[0]
					?.trim()
					.toLowerCase()
				// Start can return a bare 500 instead of throwing. Keep rendered
				// route errors (and their shell) and other response formats intact.
				if (
					response.status === 500 &&
					(!contentType || contentType === 'text/plain') &&
					request.headers
						.get('Accept')
						?.split(',')
						.some((entry) => entry.trim().split(';')[0] === 'text/html') &&
					(request.method === 'GET' || request.method === 'HEAD') &&
					!response.headers.has('Content-Disposition')
				) {
					void response.body?.cancel().catch(() => {})
					const page = renderRequestFailure(request)
					for (const cookie of response.headers.getSetCookie()) {
						page.headers.append('Set-Cookie', cookie)
					}
					return page
				}
				return response
			})
			// Start initializes shared route modules on the first request. Keep that
			// work alive if a health probe disconnects during cold initialization,
			// otherwise workerd can leave later requests waiting on cancelled I/O.
			ctx?.waitUntil(
				response.then(
					() => undefined,
					() => undefined,
				),
			)
			return await response
		} catch (error) {
			console.error('Native app request failed:', error)
			let eventId: string | undefined
			if (!wasSentryReported(error)) {
				try {
					eventId = Sentry.captureException(error, {
						tags: {
							surface: 'app-router',
							pathname: new URL(request.url).pathname,
						},
					})
				} catch {
					/* Reporting must not prevent an error response. */
				}
			}
			// Never redispatch a failed request. It may already have committed a write,
			// and Start also owns webhook, callback, and server-function dispatch.
			return renderRequestFailure(request, eventId)
		}
	}
}

function renderRequestFailure(request: Request, eventId?: string) {
	const retryHref =
		(request.method === 'GET' || request.method === 'HEAD') &&
		!isServerFunctionRequest(request)
			? retryHrefFromRequest(request)
			: null
	const response = renderInternalServerErrorPage(retryHref, eventId)
	return request.method === 'HEAD'
		? new Response(null, { status: response.status, headers: response.headers })
		: response
}

export const handleRequest = createHttpRequestHandler(async (...args) => {
	const { renderNativeDocument } = await import('./server.ts')
	return renderNativeDocument(...args)
})
