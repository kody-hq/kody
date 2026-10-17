import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { verifyOidcJwtSignature } from '#worker/oidc/keys.ts'
import { oidcSubjectBelongsToUser } from '#worker/oidc/subject.ts'

export type OidcAuthorizeParams = {
	nonce?: string
	prompt?: string
	maxAge?: number
	idTokenHint?: string
	responseType: string
}

export type OidcAuthorizeSessionContext = {
	sessionEmail: string | null
	sessionStableUserId: string | null
	sessionIssuedAt: number | undefined
}

export type OidcAuthorizeGateResult =
	| {
			ok: true
			treatAsSignedOut: boolean
			forbidInlineLogin?: boolean
			requireConsent?: boolean
			silentAuthorize?: boolean
	  }
	| {
			ok: false
			error: string
			errorCode: string
			status?: number
	  }

export function parseOidcAuthorizeParams(
	request: Request,
	searchParams = new URL(request.url).searchParams,
): OidcAuthorizeParams | { error: string; errorCode: string } {
	let maxAge: number | undefined
	if (searchParams.has('max_age')) {
		const maxAgeRaw = searchParams.get('max_age')?.trim() ?? ''
		if (!/^\d+$/.test(maxAgeRaw)) {
			return {
				error: 'max_age must be a non-negative integer.',
				errorCode: 'invalid_request',
			}
		}
		const parsed = Number.parseInt(maxAgeRaw, 10)
		if (!Number.isFinite(parsed) || parsed < 0) {
			return {
				error: 'max_age must be a non-negative integer.',
				errorCode: 'invalid_request',
			}
		}
		maxAge = parsed
	}
	return {
		nonce: searchParams.get('nonce')?.trim() || undefined,
		prompt: searchParams.get('prompt')?.trim() || undefined,
		maxAge,
		idTokenHint: searchParams.get('id_token_hint')?.trim() || undefined,
		responseType: searchParams.get('response_type')?.trim() || 'code',
	}
}

export function isOidcAuthorizeParamsParseError(
	value: ReturnType<typeof parseOidcAuthorizeParams>,
): value is { error: string; errorCode: string } {
	return 'errorCode' in value
}

export function getUnsupportedOidcResponseTypeError(responseType: string) {
	const normalized = responseType.trim()
	if (!normalized || normalized === 'code') return null
	const types = normalized.split(/\s+/)
	if (types.some((type) => type === 'id_token' || type === 'token')) {
		return 'Unsupported response type. Only authorization code (code) is supported.'
	}
	if (normalized !== 'code') {
		return `Unsupported response type: ${normalized}`
	}
	return null
}

/**
 * OIDC Core §3.1.2.1: when an ID Token is used as `id_token_hint`, its `exp`
 * need not be checked. Accept any signature-valid hint from this issuer so
 * ChatGPT-style reconnects with a stale token still recognize the session.
 */
async function readIdTokenHintSubject(input: {
	env: Env
	request: Request
	idTokenHint: string
}) {
	const issuer = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const payload = await verifyOidcJwtSignature(input.env, input.idTokenHint)
	if (!payload || payload.iss !== issuer) return null
	return typeof payload.sub === 'string' ? payload.sub : null
}

export async function evaluateOidcAuthorizeGate(input: {
	params: OidcAuthorizeParams
	session: OidcAuthorizeSessionContext
	request: Request
	env: Env
}): Promise<OidcAuthorizeGateResult> {
	const responseTypeError = getUnsupportedOidcResponseTypeError(
		input.params.responseType,
	)
	if (responseTypeError) {
		return {
			ok: false,
			error: responseTypeError,
			errorCode: 'unsupported_response_type',
		}
	}

	const prompts = input.params.prompt?.split(/\s+/).filter(Boolean) ?? []
	const wantsLogin = prompts.includes('login')
	const wantsNone = prompts.includes('none')
	const wantsConsent = prompts.includes('consent')

	if (wantsNone && (wantsLogin || wantsConsent)) {
		return {
			ok: false,
			error: 'prompt=none cannot be combined with login or consent.',
			errorCode: 'invalid_request',
			status: 400,
		}
	}

	// prompt=login forces re-authentication for this authorize request without
	// destroying the browser session cookie (so a top-nav login round-trip that
	// returns here keeps working). The authorize UI/POST treat the user as
	// signed out until they submit credentials on this form.
	if (wantsLogin) {
		return {
			ok: true,
			treatAsSignedOut: true,
			requireConsent: wantsConsent,
		}
	}

	let signedIn = Boolean(input.session.sessionEmail)

	if (signedIn && input.params.maxAge !== undefined) {
		// Fail closed: without a known auth_time, max_age cannot be evaluated.
		if (input.session.sessionIssuedAt === undefined) {
			signedIn = false
		} else {
			const authTimeSeconds = Math.floor(input.session.sessionIssuedAt / 1000)
			const nowSeconds = Math.floor(Date.now() / 1000)
			if (nowSeconds - authTimeSeconds > input.params.maxAge) {
				signedIn = false
			}
		}
	}

	if (input.params.idTokenHint && signedIn) {
		const hintSubject = await readIdTokenHintSubject({
			env: input.env,
			request: input.request,
			idTokenHint: input.params.idTokenHint,
		})
		// Invalid hint (bad signature / wrong issuer / missing sub): ignore and
		// keep the browser session. Subject mismatch: force re-auth per OIDC
		// (prompt=none → login_required below; interactive → signed-out UI).
		// Post-auth resume strips id_token_hint so a mismatch cannot loop.
		if (
			hintSubject &&
			(!input.session.sessionStableUserId ||
				!oidcSubjectBelongsToUser(
					hintSubject,
					input.session.sessionStableUserId,
				))
		) {
			signedIn = false
		}
	}

	if (wantsNone && !signedIn) {
		return {
			ok: false,
			error: 'Login required.',
			errorCode: 'login_required',
			status: 401,
		}
	}

	if (wantsNone && signedIn) {
		return {
			ok: true,
			treatAsSignedOut: false,
			forbidInlineLogin: true,
			silentAuthorize: true,
		}
	}

	return {
		ok: true,
		treatAsSignedOut: !signedIn,
		forbidInlineLogin: wantsNone,
		requireConsent: wantsConsent,
	}
}
