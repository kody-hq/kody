import { getStartRequestEnv } from './request-env.ts'

// Plain HTML form POSTs for `/login` and `/verify` (ADR 0094). Browsers that
// cannot run the page JavaScript (old engines, JavaScript turned off) submit
// the server-rendered form here and get a redirect, never JSON. Modern
// browsers keep the in-page submit. The per-IP auth rate limit runs in the
// origin handler before these, and Turnstile and the honeypot are checked by
// the same operations the in-page submit uses.

// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type { AuthFormError } from '../../universal/auth-form-errors.ts'

function isSameOriginFormPost(request: Request) {
	const requestOrigin = new URL(request.url).origin
	const origin = request.headers.get('Origin')
	if (origin) return origin === requestOrigin
	const site = request.headers.get('Sec-Fetch-Site')
	if (site) return site === 'same-origin'
	const referer = request.headers.get('Referer')
	if (!referer) return false
	try {
		return new URL(referer).origin === requestOrigin
	} catch {
		return false
	}
}

// Sign-in forms are a few short fields; anything bigger is not ours.
const maxFormBytes = 16 * 1024

async function readUrlEncodedForm(request: Request) {
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/x-www-form-urlencoded')) return null
	const declared = Number(request.headers.get('Content-Length') ?? '0')
	if (declared > maxFormBytes || !request.body) return null
	const reader = request.body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > maxFormBytes) {
				await reader.cancel().catch(() => {})
				return null
			}
			chunks.push(value)
		}
	} catch {
		await reader.cancel().catch(() => {})
		return null
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new URLSearchParams(new TextDecoder().decode(bytes))
}

function formString(form: URLSearchParams, name: string) {
	const value = form.get(name)
	return typeof value === 'string' ? value : ''
}

function seeOther(location: string, setCookies: Array<string> = []) {
	const headers = new Headers({
		Location: location,
		'Cache-Control': 'no-store',
	})
	for (const cookie of setCookies) headers.append('Set-Cookie', cookie)
	return new Response(null, { status: 303, headers })
}

/**
 * Where a plain HTML sign-in lands. A package-app authorize resume can end
 * in a redirect to the app host, which `form-action 'self'` blocks inside a
 * form submission, so that one continues with a page instead (ADR 0094).
 */
async function signedInLanding(
	redirectTo: string | null,
	cookies: Array<string>,
) {
	const [
		{ resolvePostAuthLandingPath },
		{ packageAppOauthPaths },
		{ continueNavigationResponse },
	] = await Promise.all([
		import('../../universal/safe-redirect.ts'),
		import('../../universal/package-app-oauth-paths.ts'),
		import('../../src/app/continue-navigation.ts'),
	])
	const landing = resolvePostAuthLandingPath(redirectTo) ?? '/account'
	if (
		new URL(landing, 'https://kody.invalid').pathname !==
		packageAppOauthPaths.authorize
	) {
		return seeOther(landing, cookies)
	}
	return continueNavigationResponse({ location: landing, setCookies: cookies })
}

function pagePath(
	path: '/login' | '/verify',
	redirectTo: string | null,
	error: AuthFormError,
) {
	const params = new URLSearchParams()
	if (redirectTo) params.set('redirectTo', redirectTo)
	params.set('formError', error)
	return `${path}?${params.toString()}`
}

function errorForStatus(status: number, error: unknown): AuthFormError {
	if (status === 429) return 'rate_limited'
	if (status >= 500) return 'unavailable'
	if (typeof error === 'string' && /human verification/i.test(error)) {
		return 'human_check'
	}
	return 'invalid'
}

function protectionFields(form: URLSearchParams) {
	return {
		kody_hp: formString(form, 'kody_hp'),
		turnstileToken:
			formString(form, 'turnstileToken') ||
			formString(form, 'cf-turnstile-response'),
	}
}

/** `POST /login` with `application/x-www-form-urlencoded`. */
export async function loginDocumentPost({ request }: { request: Request }) {
	const [
		{ setAuthSessionSecret },
		{ authenticateWebsite },
		{ normalizeRedirectTo },
		{ discardUnreadRequestBody },
	] = await Promise.all([
		import('../../src/app/auth-session.ts'),
		import('../../src/identity/auth-operations.ts'),
		import('../../universal/safe-redirect.ts'),
		import('../../src/request-body.ts'),
	])
	const url = new URL(request.url)
	const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
	if (!isSameOriginFormPost(request)) {
		await discardUnreadRequestBody(request)
		return new Response('Cross-origin sign-in is not allowed.', {
			status: 403,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	const form = await readUrlEncodedForm(request)
	if (!form) {
		await discardUnreadRequestBody(request)
		return seeOther(pagePath('/login', redirectTo, 'invalid'))
	}
	const env = getStartRequestEnv()
	setAuthSessionSecret(env.COOKIE_SECRET)
	const result = await authenticateWebsite({
		env,
		request,
		url: new URL('/login', request.url),
		body: {
			email: formString(form, 'email'),
			password: formString(form, 'password'),
			mode: 'login',
			rememberMe: form.get('rememberMe') === 'on',
			...protectionFields(form),
		},
	})
	const cookies = result.headers.getSetCookie()
	if (result.status >= 400) {
		const data = result.data as { error?: unknown }
		return seeOther(
			pagePath('/login', redirectTo, errorForStatus(result.status, data.error)),
			cookies,
		)
	}
	// Same landing as the in-page submit (`resolvePasswordAuthRedirect`).
	const data = result.data as { requiresTwoFactor?: unknown }
	if (data.requiresTwoFactor === true) {
		return seeOther(
			redirectTo
				? `/verify?redirectTo=${encodeURIComponent(redirectTo)}`
				: '/verify',
			cookies,
		)
	}
	return await signedInLanding(redirectTo, cookies)
}

/** `POST /verify` (two-factor code) with `application/x-www-form-urlencoded`. */
export async function verifyDocumentPost({ request }: { request: Request }) {
	const [
		{ verifyWebsiteTwoFactor },
		{ normalizeRedirectTo },
		{ discardUnreadRequestBody },
	] = await Promise.all([
		import('../../src/identity/verify-operations.ts'),
		import('../../universal/safe-redirect.ts'),
		import('../../src/request-body.ts'),
	])
	const url = new URL(request.url)
	const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
	if (!isSameOriginFormPost(request)) {
		await discardUnreadRequestBody(request)
		return new Response('Cross-origin sign-in is not allowed.', {
			status: 403,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	const form = await readUrlEncodedForm(request)
	if (!form) {
		await discardUnreadRequestBody(request)
		return seeOther(pagePath('/verify', redirectTo, 'invalid'))
	}
	const env = getStartRequestEnv()
	const result = await verifyWebsiteTwoFactor({
		env,
		request,
		url: new URL('/verify', request.url),
		body: { code: formString(form, 'code'), ...protectionFields(form) },
	})
	const cookies = result.headers.getSetCookie()
	const data = result.data as { ok?: unknown; code?: unknown; error?: unknown }
	if (result.status >= 400 || data.ok !== true) {
		if (data.code === 'expired') {
			return seeOther(pagePath('/login', redirectTo, 'expired'), cookies)
		}
		return seeOther(
			pagePath(
				'/verify',
				redirectTo,
				errorForStatus(result.status, data.error),
			),
			cookies,
		)
	}
	return await signedInLanding(redirectTo, cookies)
}
