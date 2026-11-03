import {
	ecpRunHeader,
	ecpSignatureHeader,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { buildCliClientIdMetadataDocument } from '#worker/cli-client-metadata.ts'
import { isLoopbackHostname } from '#worker/repo/artifacts.ts'

/**
 * Local `npm run dev` / `control-kody dev` has no `kody-api` edge worker, so
 * the origin itself answers `/v1/*` and `/openapi.json` on loopback hosts.
 * Production and previews never set `WRANGLER_IS_LOCAL_DEV`, and their
 * app origin keeps answering these paths with a 404.
 */
export function isLocalDevRequest(env: Env, url: URL) {
	return (
		env.WRANGLER_IS_LOCAL_DEV === 'true' &&
		url.protocol === 'http:' &&
		isLoopbackHostname(url.hostname)
	)
}

const localApiPathPattern = /^\/(?:openapi\.json|v1(?:\/.*)?)$/

export function isLocalDevApiRequest(env: Env, url: URL) {
	return isLocalDevRequest(env, url) && localApiPathPattern.test(url.pathname)
}

/** Same allowlist as the `kody-api` edge: cookies never reach the API. */
const forwardedHeaderNames = [
	'Authorization',
	ecpSignatureHeader,
	ecpRunHeader,
	'Content-Type',
	'Accept',
	'If-None-Match',
	'User-Agent',
	'X-Kody-Gateway-Url',
	'X-Kody-Gateway-Method',
	'X-Kody-Gateway-Package-Id',
	'X-Kody-Gateway-Headers',
	'x-kody-secret-resolution',
	'Upgrade',
	'Connection',
	'Sec-WebSocket-Key',
	'Sec-WebSocket-Version',
	'Sec-WebSocket-Protocol',
	'Sec-WebSocket-Extensions',
] as const

export function buildLocalDevApiRequest(request: Request) {
	const headers = new Headers()
	for (const name of forwardedHeaderNames) {
		const value = request.headers.get(name)
		if (value !== null) headers.set(name, value)
	}
	const init: RequestInit & { duplex?: 'half' } = {
		method: request.method,
		headers,
	}
	if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
		init.body = request.body
		init.duplex = 'half'
	}
	return new Request(request.url, init)
}

export async function handleLocalDevApiRequest(input: {
	request: Request
	env: Env
	ctx: ExecutionContext
	appOrigin: string
}) {
	const { handleOpenApiRequest } = await import('./http-handler.ts')
	return handleOpenApiRequest({
		request: buildLocalDevApiRequest(input.request),
		env: input.env,
		appOrigin: input.appOrigin,
		waitUntil: (promise) => input.ctx.waitUntil(promise),
		loopbackExports: input.ctx.exports,
	})
}

const seededCliClientOrigins = new Map<string, Promise<void>>()

/**
 * The OAuth provider only fetches HTTPS Client ID Metadata Documents, so on
 * a plain-HTTP loopback origin the CLI's `<origin>/oauth/cli-client-metadata.json`
 * client id is looked up in OAUTH_KV instead. Register it there from the
 * same document the origin serves, so `kody login` works locally.
 */
export function ensureLocalCliClientRegistration(env: Env, origin: string) {
	const existing = seededCliClientOrigins.get(origin)
	if (existing) return existing
	const pending = (async () => {
		const document = buildCliClientIdMetadataDocument(origin)
		const key = `client:${document.client_id}`
		if (await env.OAUTH_KV.get(key)) return
		await env.OAUTH_KV.put(
			key,
			JSON.stringify({
				clientId: document.client_id,
				redirectUris: document.redirect_uris,
				clientName: document.client_name,
				clientUri: document.client_uri,
				tokenEndpointAuthMethod: document.token_endpoint_auth_method,
				grantTypes: document.grant_types,
				responseTypes: document.response_types,
				registrationDate: Math.floor(Date.now() / 1000),
			}),
		)
	})().catch((error: unknown) => {
		seededCliClientOrigins.delete(origin)
		throw error
	})
	seededCliClientOrigins.set(origin, pending)
	return pending
}
