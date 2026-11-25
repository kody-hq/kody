import { mintIdToken, type OidcGrantProps } from '#worker/oidc/id-token.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { mediaType } from '@kody-internal/shared/media-type.ts'

type TokenEnrichmentHelpers = {
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

function scopeIncludesOpenid(scope: unknown) {
	if (typeof scope === 'string') {
		return scope.split(/\s+/).includes('openid')
	}
	if (Array.isArray(scope)) {
		return scope.includes('openid')
	}
	return false
}

async function readTokenGrantType(request: Request) {
	const contentType = mediaType(request.headers.get('Content-Type'))
	if (contentType !== 'application/x-www-form-urlencoded') return null
	const formData = await request
		.clone()
		.formData()
		.catch(() => null)
	const grantType = formData?.get('grant_type')
	return typeof grantType === 'string' ? grantType : null
}

export async function enrichOAuthTokenResponse(
	request: Request,
	response: Response,
	env: Env,
	options: { grantType?: string | null } = {},
) {
	if (response.status < 200 || response.status >= 300) return response
	const contentType = mediaType(response.headers.get('Content-Type'))
	if (contentType !== 'application/json') return response

	const body = (await response.clone().json()) as Record<string, unknown>
	if (typeof body.access_token !== 'string' || !body.access_token) {
		return response
	}
	if (!scopeIncludesOpenid(body.scope)) {
		return response
	}

	// The provider handles `/oauth/token` internally and never injects
	// `env.OAUTH_PROVIDER` on that path. A later authorize request in the
	// same isolate can leave helpers on `env` (local tests), but a fresh
	// production token request must build them through `resolveOAuthHelpers`.
	const helpers = await resolveOAuthHelpers<TokenEnrichmentHelpers>(env)
	if (!helpers) return response
	const tokenSummary = await helpers.unwrapToken<OidcGrantProps>(
		body.access_token,
	)
	if (!tokenSummary) return response

	const grantType = options.grantType ?? (await readTokenGrantType(request))
	const includeNonce = grantType !== 'refresh_token'
	const idToken = await mintIdToken({
		env,
		request,
		clientId: tokenSummary.grant.clientId,
		scope: tokenSummary.scope,
		props: tokenSummary.grant.props,
		includeNonce,
	})

	const enriched = {
		...body,
		id_token: idToken,
	}
	const headers = new Headers(response.headers)
	headers.set('Cache-Control', 'no-store')
	headers.set('Content-Type', 'application/json; charset=utf-8')
	return new Response(JSON.stringify(enriched), {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
