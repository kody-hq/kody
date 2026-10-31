/**
 * Kody's CSP locks `form-action` to 'self', and browsers apply it to every
 * redirect that follows a form submission. A plain HTML form (ADR 0094) whose
 * result must land on another origin (an app host's `/-/auth/*`) therefore
 * cannot answer with a redirect. This page ends the form submission and moves
 * on with an HTTP `Refresh`, a new navigation that `form-action` does not
 * cover, plus a link for browsers that ignore it. No script is involved.
 */
export function continueNavigationResponse(input: {
	location: string
	setCookies?: Array<string>
}) {
	const href = escapeHtml(input.location)
	const headers = new Headers({
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		Refresh: `0; url=${input.location}`,
	})
	for (const cookie of input.setCookies ?? []) {
		headers.append('Set-Cookie', cookie)
	}
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continuing</title></head><body><main style="max-width:28rem;margin:4rem auto;padding:0 1.25rem;font-family:system-ui,sans-serif;line-height:1.5"><p>Continuing to the app.</p><p><a href="${href}">Continue</a></p></main></body></html>`,
		{ status: 200, headers },
	)
}

/** True when a redirect response would leave `requestUrl`'s origin. */
export function isCrossOriginRedirect(response: Response, requestUrl: string) {
	if (response.status < 300 || response.status >= 400) return false
	const location = response.headers.get('Location')
	if (!location) return false
	try {
		return new URL(location, requestUrl).origin !== new URL(requestUrl).origin
	} catch {
		return false
	}
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}
