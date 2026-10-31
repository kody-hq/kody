import { getStartRequestEnv } from './request-env.ts'

// Server route handlers for `/agent/claim`. Kept apart from the
// `loadAgentClaimPage` server function so the client build can drop this
// module (and the worker code it imports) along with `server.handlers`.

function isSameOriginPost(request: Request) {
	const origin = request.headers.get('Origin')
	const requestOrigin = new URL(request.url).origin
	if (origin) return origin === requestOrigin
	const site = request.headers.get('Sec-Fetch-Site')
	return site === 'same-origin'
}

function seeOther(location: URL) {
	return new Response(null, {
		status: 303,
		headers: {
			Location: `${location.pathname}${location.search}`,
			'Cache-Control': 'no-store',
		},
	})
}

/** `POST /agent/claim`: Approve (with the code) or Deny from the consent form. */
export async function handleAgentClaimPost({ request }: { request: Request }) {
	const [
		{ setAuthSessionSecret },
		{ readAuthenticatedAppUser },
		{ decideAgentClaimForPerson },
		{ discardUnreadRequestBody },
	] = await Promise.all([
		import('../../src/app/auth-session.ts'),
		import('../../src/app/authenticated-user.ts'),
		import('../../src/agent-registration/verification.ts'),
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
	const attemptToken = String(form.get('claim_attempt_token') ?? '').trim()
	const userCode = String(form.get('user_code') ?? '').trim()
	const decisionValue = String(form.get('decision') ?? '')
	const orgValue = String(form.get('org') ?? '').trim()
	const location = new URL('/agent/claim', request.url)
	if (attemptToken) {
		location.searchParams.set('claim_attempt_token', attemptToken)
	}
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return seeOther(location)
	if (decisionValue !== 'approve' && decisionValue !== 'deny') {
		return new Response('Unknown decision', { status: 400 })
	}
	const result = await decideAgentClaimForPerson({
		request,
		env,
		user: { personId: user.mcpUser.userId, email: user.email },
		attemptToken: attemptToken || null,
		userCode: userCode || null,
		decision: decisionValue,
		orgSlug: orgValue || null,
	})
	if (result.kind === 'approved' || result.kind === 'denied') {
		const done = new URL('/agent/claim', request.url)
		done.searchParams.set('result', result.kind)
		return seeOther(done)
	}
	if (result.kind === 'not_found' || result.kind === 'email_mismatch') {
		return seeOther(location)
	}
	location.searchParams.set('error', result.kind)
	return seeOther(location)
}

export function rejectAgentClaimMethod() {
	return new Response('Method not allowed', {
		status: 405,
		headers: { Allow: 'GET, POST' },
	})
}
