import { jsonResponse } from '#worker/json-response.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import type { OidcGrantProps } from '#worker/oidc/id-token.ts'
import { oidcSubject } from '#worker/oidc/subject.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'

type OidcUserinfoOAuthHelpers = {
	unwrapToken: <T = OidcGrantProps>(
		token: string,
	) => Promise<{
		scope: Array<string>
		grant: {
			clientId: string
			scope: Array<string>
			props: T
		}
	} | null>
}

type OAuthEnv = Env & {
	OAUTH_PROVIDER?: OidcUserinfoOAuthHelpers
}

function readBearerToken(request: Request) {
	const authorization = request.headers.get('Authorization')?.trim()
	if (!authorization?.toLowerCase().startsWith('bearer ')) return null
	const token = authorization.slice('bearer '.length).trim()
	return token || null
}

async function readAccessToken(request: Request) {
	const bearer = readBearerToken(request)
	if (bearer) return bearer
	if (request.method !== 'POST') return null
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/x-www-form-urlencoded')) return null
	const formData = await request.formData().catch(() => null)
	const accessToken = formData?.get('access_token')
	return typeof accessToken === 'string' && accessToken.trim()
		? accessToken.trim()
		: null
}

export async function handleOidcUserinfoRequest(request: Request, env: Env) {
	if (
		request.method !== 'GET' &&
		request.method !== 'HEAD' &&
		request.method !== 'POST'
	) {
		return new Response('Method not allowed', { status: 405 })
	}

	const token = await readAccessToken(request)
	if (!token) {
		return jsonResponse(
			{
				error: 'invalid_token',
				error_description: 'Missing or invalid bearer token.',
			},
			{ status: 401 },
		)
	}

	// UserInfo is served before `oauthProvider.fetch`, so the library never
	// injects `env.OAUTH_PROVIDER` here. Build the same helpers over OAUTH_KV.
	const helpers = await resolveOAuthHelpers<OidcUserinfoOAuthHelpers>(
		env as OAuthEnv,
	)
	if (!helpers) {
		return jsonResponse(
			{
				error: 'invalid_token',
				error_description: 'Access token is invalid or expired.',
			},
			{ status: 401 },
		)
	}
	const tokenSummary = await helpers.unwrapToken<OidcGrantProps>(token)
	if (!tokenSummary) {
		return jsonResponse(
			{
				error: 'invalid_token',
				error_description: 'Access token is invalid or expired.',
			},
			{ status: 401 },
		)
	}

	if (!tokenSummary.scope.includes('openid')) {
		return jsonResponse(
			{
				error: 'insufficient_scope',
				error_description: 'openid scope is required for UserInfo.',
			},
			{ status: 403 },
		)
	}

	const props = tokenSummary.grant.props
	const emailVerified = await isAccountEmailVerified({
		db: env.APP_DB,
		email: props.email,
		stableUserId: props.userId,
	})
	if (!emailVerified) {
		return jsonResponse(
			{
				error: 'invalid_token',
				error_description: 'Account email is not verified.',
			},
			{ status: 401 },
		)
	}

	const claims: Record<string, unknown> = {
		sub: oidcSubject(props),
	}
	if (tokenSummary.scope.includes('email')) {
		claims.email = props.email
		claims.email_verified = true
	}
	if (tokenSummary.scope.includes('profile')) {
		claims.preferred_username = props.username
		claims.name = props.displayName
	}

	const headers = {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return jsonResponse(claims, { headers })
}
