import { authOperationResult } from './auth-operation-result.ts'
import { getCallbackRedirectUri } from './oauth-provider-redirect.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { readAuthSessionResult, isSecureRequest } from '#app/auth-session.ts'
import {
	parseFirstTouchAttribution,
	hasFirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'
import { checkPublicFormProtection } from '#app/public-form-protection.ts'
import {
	oauthLoginErrorMessages,
	type OauthLoginErrorCode,
} from '#universal/oauth-login-errors.ts'
import {
	isOauthProviderId,
	getOauthClientConfig,
	generateOauthRandomValue,
	buildAuthorizeRedirectUrl,
} from '#app/oauth-providers.ts'
import {
	setOauthLoginStateSecret,
	createOauthLoginStateCookie,
} from '#app/oauth-login-state.ts'

export async function startWebsiteOAuth({
	env,
	request,
	url,
	body,
	provider,
}: {
	env: Env
	request: Request
	url: URL
	body: Record<string, unknown>
	provider: string
}) {
	const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
	const attribution = parseFirstTouchAttribution({
		searchParams: url.searchParams,
		body: null,
	})
	const { session } = await readAuthSessionResult(request)

	if (!session) {
		const protection = await checkPublicFormProtection({
			env,
			request,
			body: typeof body === 'object' && body !== null ? body : {},
		})
		if (!protection.ok)
			return authOperationResult({ ok: false, error: protection.error }, 400)
	}

	function startError(code: OauthLoginErrorCode) {
		return authOperationResult(
			{ ok: false, code, error: oauthLoginErrorMessages[code] },
			400,
		)
	}

	const providerParam = provider
	if (!isOauthProviderId(providerParam)) {
		return startError('unknown-provider')
	}
	if (!getOauthClientConfig(env, providerParam)) {
		return startError('not-configured')
	}

	setOauthLoginStateSecret(env.COOKIE_SECRET)
	const state = generateOauthRandomValue()
	const codeVerifier = generateOauthRandomValue()
	const authorizeUrl = await buildAuthorizeRedirectUrl({
		env,
		provider: providerParam,
		state,
		codeVerifier,
		redirectUri: getCallbackRedirectUri(env, url, providerParam),
	})
	const stateCookie = await createOauthLoginStateCookie(
		{
			provider: providerParam,
			state,
			codeVerifier,
			redirectTo,
			attribution: hasFirstTouchAttribution(attribution) ? attribution : null,
		},
		isSecureRequest(request),
	)
	return authOperationResult(
		{ ok: true, authorizeUrl },
		{ headers: { 'Set-Cookie': stateCookie } },
	)
}
