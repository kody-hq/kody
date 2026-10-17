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
			return await inRequest(async () => {
				if (isServerFunctionRequest(request)) {
					const response = await renderDocument(request, bindings)
					// Start serializes thrown redirects after request middleware finishes.
					// Enforce RPC privacy on the final response, even when shared document
					// loaders set public caching for their canonical document redirects.
					const headers = new Headers(response.headers)
					headers.set('Cache-Control', 'private, no-store')
					return new Response(response.body, {
						status: response.status,
						statusText: response.statusText,
						headers,
					})
				}
				return renderDocument(request, bindings)
			})
		} catch (error) {
			console.error('Native app request failed:', error)
			if (!wasSentryReported(error)) {
				try {
					Sentry.captureException(error, {
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
			const response = renderInternalServerErrorPage(
				retryHrefFromRequest(request),
			)
			return request.method === 'HEAD'
				? new Response(null, {
						status: response.status,
						headers: response.headers,
					})
				: response
		}
	}
}

export const handleRequest = createHttpRequestHandler(async (...args) => {
	const { renderNativeDocument } = await import('./server.ts')
	return renderNativeDocument(...args)
})
