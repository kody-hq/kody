import { getStartRequestEnv } from './request-env.ts'

// Server route handlers for `/claim/<code>`. Kept apart from the loader so the
// client build drops this module with `server.handlers`.

function isSameOriginPost(request: Request) {
	const origin = request.headers.get('Origin')
	const requestOrigin = new URL(request.url).origin
	if (origin) return origin === requestOrigin
	return request.headers.get('Sec-Fetch-Site') === 'same-origin'
}

function seeOther(location: string, headers?: HeadersInit) {
	const out = new Headers(headers)
	out.set('Location', location)
	out.set('Cache-Control', 'no-store')
	return new Response(null, { status: 303, headers: out })
}

export function rejectGuestClaimMethod() {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: { Allow: 'GET, POST' },
	})
}

/** `POST /claim/<code>`: email code start/finish, signed-in merge, social start. */
export async function handleGuestClaimPost({
	request,
	params,
}: {
	request: Request
	params: { code: string }
}) {
	const [
		{ setAuthSessionSecret, createAuthCookie, isSecureRequest },
		{ readAuthenticatedAppUser },
		{ readGuestAccountByClaimCode, guestEmailDomain },
		claim,
		{ startGuestClaim, finishGuestClaim, GuestClaimCodeError },
		{ startWebsiteOAuth },
		{ getAppBaseUrl },
		{ discardUnreadRequestBody },
	] = await Promise.all([
		import('../../src/app/auth-session.ts'),
		import('../../src/app/authenticated-user.ts'),
		import('../../src/guest/guest-accounts.ts'),
		import('../../src/guest/guest-claim.ts'),
		import('../../src/guest/guest-claim-code.ts'),
		import('../../src/identity/oauth-start-operation.ts'),
		import('../../src/app-base-url.ts'),
		import('../../src/request-body.ts'),
	])
	if (!isSameOriginPost(request)) {
		await discardUnreadRequestBody(request)
		return new Response('Forbidden', { status: 403 })
	}
	const env = getStartRequestEnv()
	setAuthSessionSecret(env.COOKIE_SECRET)
	const contentType = request.headers.get('Content-Type') ?? ''
	const form = contentType.includes('application/x-www-form-urlencoded')
		? await request.formData().catch(() => null)
		: null
	if (!form) {
		await discardUnreadRequestBody(request)
		return new Response('Unsupported form submission', { status: 415 })
	}
	const code = params.code
	const pagePath = `/claim/${encodeURIComponent(code)}`
	const fail = (error: string, extra?: Record<string, string>) =>
		seeOther(`${pagePath}?${new URLSearchParams({ error, ...extra })}`)
	const guest = await readGuestAccountByClaimCode(env, code)
	if (!guest || guest.claimedAt) return fail('already_claimed')
	const action = String(form.get('action') ?? '')
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	const field = (name: string) => String(form.get(name) ?? '').trim()
	const loginAs = async (personId: string) => {
		const row = await env.APP_DB.prepare(
			`SELECT email FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
		)
			.bind(personId)
			.first<{ email: string }>()
		if (!row) return undefined
		return createAuthCookie(
			{ stableUserId: personId as never, email: row.email, rememberMe: true },
			isSecureRequest(request),
		)
	}
	try {
		if (action === 'email_start') {
			const started = await startGuestClaim({
				env,
				guest,
				email: field('email'),
				username: field('username') || null,
				merge: field('mode') === 'merge',
				requestUrl: request.url,
			})
			const next = new URLSearchParams({ step: 'code', email: started.email })
			if (started.devCode) next.set('dev_code', started.devCode)
			return seeOther(`${pagePath}?${next}`)
		}
		if (action === 'email_finish') {
			const comesWith = await claim.guestComesWithCounts(env, guest)
			const result = await finishGuestClaim({
				env,
				guest,
				code: field('code'),
				baseUrl,
				method: 'email_code',
			})
			const setCookie = await loginAs(result.personId)
			return seeOther(
				claim.guestClaimDonePath(code, result.mode, comesWith),
				setCookie ? { 'Set-Cookie': setCookie } : undefined,
			)
		}
		if (action === 'merge_signed_in') {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user || user.email.endsWith(`@${guestEmailDomain}`)) {
				return fail('no_account')
			}
			const target = await claim.findClaimTargetByDbId(env.APP_DB, user.userId)
			if (!target) return fail('account_unavailable')
			const comesWith = await claim.guestComesWithCounts(env, guest)
			const result = await claim.mergeGuestIntoAccount({
				env,
				guest,
				target,
				baseUrl,
				method: 'signed_in_merge',
			})
			return seeOther(claim.guestClaimDonePath(code, result.mode, comesWith))
		}
		if (action === 'provider') {
			const provider = field('provider')
			const started = await startWebsiteOAuth({
				env,
				request,
				url: new URL(request.url),
				body: {},
				provider,
				guestClaim: { code, username: field('username') || null },
			})
			const data = started.data as { ok: boolean; authorizeUrl?: string }
			if (!data.ok || !data.authorizeUrl) return fail('provider_unavailable')
			return seeOther(data.authorizeUrl, started.headers)
		}
		return new Response('Unknown claim action', { status: 400 })
	} catch (error) {
		if (error instanceof GuestClaimCodeError) {
			const keepCodeStep =
				action === 'email_finish' &&
				(error.code === 'code_invalid' || error.code === 'code_missing')
			return fail(
				error.code,
				keepCodeStep ? { step: 'code', email: field('email') } : undefined,
			)
		}
		if (error instanceof claim.GuestClaimError) return fail(error.code)
		throw error
	}
}
