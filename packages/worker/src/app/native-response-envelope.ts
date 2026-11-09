import {
	officePreviewPolicy,
	officePreviewPermissions,
} from '#universal/office-preview.ts'
import {
	assetCacheControls,
	fileAssetPolicy,
	signedAssetRouteToken,
} from '#universal/file-assets.ts'
import {
	htmlPreviewCsp,
	htmlPreviewPermissions,
} from '#universal/html-preview.ts'
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
	// An upgraded connection owns a WebSocket, not an HTTP document body.
	// Reconstructing it with the standard Response loses the upgrade.
	if (response.status === 101) return response
	const url = new URL(request.url)
	const officeScript = url.searchParams.get('script') ?? ''
	if (
		request.method === 'GET' &&
		/^\/office-preview\/[a-zA-Z0-9_-]+\/(docx|xlsx|pptx)$/.test(url.pathname) &&
		/^(?:\/__start\/[a-f0-9]{40})?\/office-viewers\/(docx|xlsx|pptx)-[a-f0-9]{12}\.js$/.test(
			officeScript,
		) &&
		response.status === 200 &&
		response.headers.get('X-Kody-Office-Preview') === '1'
	) {
		const headers = new Headers(response.headers)
		headers.delete('X-Frame-Options')
		headers.delete('X-Kody-Desktop-Navigation')
		headers.delete('X-Kody-Desktop-Authentication')
		headers.set(
			'Content-Security-Policy',
			officePreviewPolicy(url.origin, officeScript),
		)
		headers.set('Permissions-Policy', officePreviewPermissions)
		headers.set('Cache-Control', 'private, no-store')
		headers.set('Referrer-Policy', 'no-referrer')
		headers.set('X-Content-Type-Options', 'nosniff')
		return new Response(response.body, { status: 200, headers })
	}

	if (
		['GET', 'HEAD'].includes(request.method) &&
		(/^\/file-assets\/[a-zA-Z0-9_-]+\/[a-fA-F0-9-]{36}$/.test(url.pathname) ||
			/^\/shared-file-assets\/[a-zA-Z0-9_-]+\/[a-fA-F0-9-]{36}\/[a-f0-9]{64}\/[a-fA-F0-9-]{36}$/.test(
				url.pathname,
			)) &&
		[200, 206, 416].includes(response.status) &&
		response.headers.get('X-Kody-File-Asset') === '1'
	) {
		const headers = new Headers(response.headers)
		headers.set(
			'Content-Security-Policy',
			fileAssetPolicy(headers.get('Content-Type')),
		)
		headers.set('X-Frame-Options', 'SAMEORIGIN')
		if (
			!url.pathname.startsWith('/shared-file-assets/') ||
			url.pathname.split('/')[4] === signedAssetRouteToken ||
			url.searchParams.get('asset') !== '1' ||
			!assetCacheControls.some(
				(value) => value === headers.get('Cache-Control'),
			)
		)
			headers.set('Cache-Control', 'private, no-store')
		headers.set('X-Content-Type-Options', 'nosniff')
		headers.set('Referrer-Policy', 'no-referrer')
		return new Response(response.body, { status: response.status, headers })
	}

	// This protocol response is a trusted wrapper, not a Kody application document.
	// Set policy constants here rather than accepting arbitrary response CSP values.
	if (
		request.method === 'GET' &&
		/^\/html-preview\/[a-zA-Z0-9_-]+$/.test(url.pathname) &&
		response.status === 200 &&
		response.headers.get('X-Kody-Isolated-Preview') === '1'
	) {
		const headers = new Headers(response.headers)
		headers.delete('X-Frame-Options')
		headers.delete('X-Kody-Desktop-Navigation')
		headers.delete('X-Kody-Desktop-Authentication')
		headers.set('Content-Security-Policy', htmlPreviewCsp)
		headers.set('Permissions-Policy', htmlPreviewPermissions)
		headers.set('Cache-Control', 'private, no-store')
		headers.set('Referrer-Policy', 'no-referrer')
		headers.set('X-Content-Type-Options', 'nosniff')
		return new Response(response.body, { status: 200, headers })
	}
	const status = documentFailure?.status ?? response.status
	const negotiatedNotFound =
		status === 404 &&
		['GET', 'HEAD'].includes(request.method) &&
		Boolean(response.headers.get('Content-Type')?.includes('text/html'))
	const markdown = negotiatedNotFound && prefersMarkdown(request)
	const headers = new Headers(response.headers)
	if (!markdown && headers.get('Content-Type')?.includes('text/html')) {
		headers.set('X-Kody-Desktop-Navigation', '1')
		headers.set('X-Kody-Desktop-Authentication', '1')
	}
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
