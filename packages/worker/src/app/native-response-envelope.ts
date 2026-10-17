import { prefersMarkdown, withVaryAccept } from './markdown-negotiation.ts'
import {
	buildNotFoundMarkdown,
	withAgentDiscoveryLinkHeaders,
} from './agent-discovery.ts'
import { getAppBaseUrl } from '../app-base-url.ts'
import {
	resolveAppPageCacheControl,
	type AnonymousDocumentCachePolicy,
} from './anonymous-html-cache.ts'
import { firstPartySecurityHeaders } from './security-headers.ts'
export function secureNativeResponse(
	request: Request,
	response: Response,
	env: Env,
	nonce: string,
	documentFailure?: { status: 403 | 404 | 500 },
	policy?: AnonymousDocumentCachePolicy,
) {
	const url = new URL(request.url)
	const status = documentFailure?.status ?? response.status
	const negotiatedNotFound =
		status === 404 &&
		['GET', 'HEAD'].includes(request.method) &&
		Boolean(response.headers.get('Content-Type')?.includes('text/html'))
	const markdown = negotiatedNotFound && prefersMarkdown(request)
	const headers = new Headers(response.headers)
	if (markdown) {
		headers.set('Cache-Control', 'no-store')
		headers.set('Content-Type', 'text/markdown; charset=utf-8')
		headers.delete('Content-Length')
		headers.delete('Content-Encoding')
	}
	for (const [name, value] of Object.entries(firstPartySecurityHeaders))
		headers.set(name, value)
	headers.set(
		'Content-Security-Policy',
		`${firstPartySecurityHeaders['Content-Security-Policy']}`.replace(
			"script-src 'self'",
			`script-src 'self' 'nonce-${nonce}'`,
		),
	)
	const cache = resolveAppPageCacheControl({
		policy,
		request,
		session: request.headers.has('Authorization') ? {} : null,
		responseSetsCookie: headers.has('Set-Cookie'),
		status: documentFailure?.status ?? response.status,
		localDev: env.WRANGLER_IS_LOCAL_DEV === 'true',
	})
	if (
		(headers.get('Content-Type')?.includes('text/html') &&
			response.status === 200) ||
		!headers.has('Cache-Control')
	)
		headers.set('Cache-Control', cache.cacheControl)
	if (cache.vary) headers.append('Vary', cache.vary)
	let documentResponse = new Response(
		request.method === 'HEAD'
			? null
			: markdown
				? buildNotFoundMarkdown(getAppBaseUrl({ env, requestUrl: request.url }))
				: response.body,
		{
			status: documentFailure?.status ?? response.status,
			statusText: response.statusText,
			headers,
		},
	)
	if (negotiatedNotFound) documentResponse = withVaryAccept(documentResponse)
	return url.pathname === '/' &&
		headers.get('Content-Type')?.includes('text/html')
		? withAgentDiscoveryLinkHeaders(
				documentResponse,
				getAppBaseUrl({ env, requestUrl: request.url }),
			)
		: documentResponse
}
