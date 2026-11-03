import type { ClientInfo } from '@cloudflare/workers-oauth-provider'
import {
	destroyAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { getEnv } from '#app/env.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { verifyOidcJwtSignature } from '#worker/oidc/keys.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'

type LogoutOAuthHelpers = {
	lookupClient: (clientId: string) => Promise<ClientInfo | null>
}

type OAuthEnv = Env & {
	OAUTH_PROVIDER?: LogoutOAuthHelpers
}

type LogoutParams = {
	postLogoutRedirectUri: string | null
	state: string | null
	idTokenHint: string | null
	clientId: string | null
}

function readRegisteredRedirectUris(client: ClientInfo) {
	const redirectUris = (client as { redirectUris?: unknown }).redirectUris
	return Array.isArray(redirectUris) &&
		redirectUris.every((uri) => typeof uri === 'string')
		? redirectUris
		: null
}

function isAllowedPostLogoutRedirectUri(
	redirectUri: string,
	registeredUris: Array<string> | null,
) {
	if (!registeredUris) return false
	return registeredUris.some((registeredUri) => registeredUri === redirectUri)
}

function readAudienceClientIds(payload: Record<string, unknown>) {
	const aud = payload.aud
	if (typeof aud === 'string' && aud.trim()) return [aud.trim()]
	if (Array.isArray(aud)) {
		return aud
			.filter((value): value is string => typeof value === 'string')
			.map((value) => value.trim())
			.filter((value) => value.length > 0)
	}
	return []
}

async function readLogoutParams(request: Request): Promise<LogoutParams> {
	if (request.method === 'POST') {
		const contentType = request.headers.get('Content-Type') ?? ''
		if (contentType.includes('application/x-www-form-urlencoded')) {
			const formData = await request.formData().catch(() => null)
			return {
				postLogoutRedirectUri:
					String(formData?.get('post_logout_redirect_uri') ?? '').trim() ||
					null,
				state: String(formData?.get('state') ?? '').trim() || null,
				idTokenHint:
					String(formData?.get('id_token_hint') ?? '').trim() || null,
				clientId: String(formData?.get('client_id') ?? '').trim() || null,
			}
		}
	}
	const url = new URL(request.url)
	return {
		postLogoutRedirectUri:
			url.searchParams.get('post_logout_redirect_uri')?.trim() || null,
		state: url.searchParams.get('state')?.trim() || null,
		idTokenHint: url.searchParams.get('id_token_hint')?.trim() || null,
		clientId: url.searchParams.get('client_id')?.trim() || null,
	}
}

export async function handleOidcLogoutRequest(request: Request, env: Env) {
	if (
		request.method !== 'GET' &&
		request.method !== 'HEAD' &&
		request.method !== 'POST'
	) {
		return new Response('Method not allowed', { status: 405 })
	}

	const params = await readLogoutParams(request)
	let clientId = params.clientId

	if (params.idTokenHint) {
		const issuer = getAppBaseUrl({
			env,
			requestUrl: request.url,
		})
		const payload = await verifyOidcJwtSignature(env, params.idTokenHint)
		if (!payload || payload.iss !== issuer) {
			return new Response('Invalid id_token_hint', { status: 400 })
		}
		const audienceClientIds = readAudienceClientIds(payload)
		if (audienceClientIds.length === 0) {
			return new Response('Invalid id_token_hint', { status: 400 })
		}
		if (clientId && !audienceClientIds.includes(clientId)) {
			return new Response('Invalid client_id for id_token_hint', {
				status: 400,
			})
		}
		clientId = clientId ?? audienceClientIds[0] ?? null
	}

	if (params.postLogoutRedirectUri) {
		// RP-Initiated Logout: only redirect for an RP that proves it holds an
		// id_token we issued; a bare client_id is not proof (DCR is open).
		if (!params.idTokenHint) {
			return new Response('post_logout_redirect_uri requires id_token_hint', {
				status: 400,
			})
		}
		let allowed = false
		if (clientId) {
			const helpers = await resolveOAuthHelpers<LogoutOAuthHelpers>(
				env as OAuthEnv,
			)
			try {
				const client = helpers ? await helpers.lookupClient(clientId) : null
				if (client) {
					allowed = isAllowedPostLogoutRedirectUri(
						params.postLogoutRedirectUri,
						readRegisteredRedirectUris(client),
					)
				}
			} catch {
				allowed = false
			}
		}
		if (!allowed) {
			return new Response('Invalid post_logout_redirect_uri', { status: 400 })
		}
	}

	const appEnv = getEnv(env)
	setAuthSessionSecret(appEnv.COOKIE_SECRET)
	const clearSessionCookie = await destroyAuthCookie(isSecureRequest(request))
	const headers = new Headers({
		'Cache-Control': 'no-store',
		'Set-Cookie': clearSessionCookie,
	})

	if (params.postLogoutRedirectUri) {
		const redirectUrl = new URL(params.postLogoutRedirectUri)
		if (params.state) redirectUrl.searchParams.set('state', params.state)
		headers.set('Location', redirectUrl.toString())
		return new Response(null, { status: 302, headers })
	}

	return new Response('Signed out.', {
		status: 200,
		headers,
	})
}
