import { getStartRequestEnv } from './request-env.ts'

// Server route handlers for `/newsletter` and `/newsletter/confirm`. Kept
// apart from the `loadNewsletterPage` server function so the client build can
// drop this module (and the worker code it imports) along with the routes'
// `server.handlers`.

function isSameOriginPost(request: Request) {
	const origin = request.headers.get('Origin')
	const requestOrigin = new URL(request.url).origin
	if (origin) return origin === requestOrigin
	const site = request.headers.get('Sec-Fetch-Site')
	return site === 'same-origin'
}

function seeOther(
	request: Request,
	path: string,
	params: Record<string, string>,
) {
	const location = new URL(path, request.url)
	for (const [name, value] of Object.entries(params))
		location.searchParams.set(name, value)
	return new Response(null, {
		status: 303,
		headers: {
			Location: `${location.pathname}${location.search}`,
			'Cache-Control': 'no-store',
		},
	})
}

async function readForm(request: Request) {
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/x-www-form-urlencoded')) return null
	const form = await request.formData().catch(() => null)
	if (!form) return null
	const fields: Record<string, string> = {}
	for (const [name, value] of form)
		if (typeof value === 'string') fields[name] = value
	return fields
}

async function rejectForm(request: Request, status: 403 | 415) {
	const { discardUnreadRequestBody } = await import('../../src/request-body.ts')
	await discardUnreadRequestBody(request)
	return new Response(
		status === 403 ? 'Forbidden' : 'Unsupported form submission',
		{ status },
	)
}

/**
 * `POST /newsletter`: a plain form post, so it works without JavaScript. It
 * only emails a confirmation link; the outcome is shown after a redirect.
 */
export async function handleNewsletterSignupPost({
	request,
}: {
	request: Request
}) {
	if (!isSameOriginPost(request)) return rejectForm(request, 403)
	const form = await readForm(request)
	if (!form) return rejectForm(request, 415)
	const [{ handleNewsletterSignup }, { waitUntil }] = await Promise.all([
		import('../../src/newsletter/edges.ts'),
		import('cloudflare:workers'),
	])
	const redirect = await handleNewsletterSignup({
		env: getStartRequestEnv(),
		request,
		form,
		waitUntil,
	})
	return seeOther(request, '/newsletter', redirect)
}

/**
 * `POST /newsletter/confirm`: the button on the page the emailed link opens.
 * Opening the link (GET) changes nothing, so mail scanners cannot subscribe
 * an address by prefetching it.
 */
export async function handleNewsletterConfirmPost({
	request,
}: {
	request: Request
}) {
	if (!isSameOriginPost(request)) return rejectForm(request, 403)
	const form = await readForm(request)
	if (!form) return rejectForm(request, 415)
	const [{ handleNewsletterConfirm }, { waitUntil }] = await Promise.all([
		import('../../src/newsletter/edges.ts'),
		import('cloudflare:workers'),
	])
	const redirect = await handleNewsletterConfirm({
		env: getStartRequestEnv(),
		request,
		token: form.token,
		waitUntil,
	})
	return seeOther(request, '/newsletter', redirect)
}

export function rejectNewsletterMethod() {
	return new Response('Method not allowed', {
		status: 405,
		headers: { Allow: 'GET, HEAD, POST' },
	})
}
