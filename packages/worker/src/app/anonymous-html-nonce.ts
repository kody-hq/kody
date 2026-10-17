/** Keep cached SSR documents reusable without sharing a script nonce with visitors. */
export function prepareNonceHtmlForDelivery(
	response: Response,
	{ cached, nonce: deliveryNonce }: { cached: boolean; nonce?: string },
) {
	if (
		!response.headers.get('Content-Type')?.toLowerCase().includes('text/html')
	)
		return response
	const policy = response.headers.get('Content-Security-Policy')
	const previous = policy?.match(/'nonce-([A-Za-z0-9+/_=-]+)'/)?.[1]
	if (!previous || !policy) return response
	const nonce = cached
		? (deliveryNonce ?? crypto.randomUUID().replaceAll('-', ''))
		: previous
	const headers = new Headers(response.headers)
	headers.set(
		'Content-Security-Policy',
		policy.replaceAll(`'nonce-${previous}'`, `'nonce-${nonce}'`),
	)
	// Shared storage lives inside the Worker. Browsers and downstream caches
	// must ask it for a new nonce instead of replaying a delivered document.
	headers.set('Cache-Control', 'private, no-store')
	headers.delete('Content-Length')
	headers.delete('ETag')
	const fresh = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
	// A fresh SSR stream already has a unique nonce. Only replayed cache entries
	// need markup rewriting.
	if (!cached || !response.body) return fresh
	return new HTMLRewriter()
		.on('[nonce]', {
			element(element) {
				if (element.getAttribute('nonce') === previous)
					element.setAttribute('nonce', nonce)
			},
		})
		.on('meta[property="csp-nonce"]', {
			element(element) {
				if (element.getAttribute('content') === previous)
					element.setAttribute('content', nonce)
			},
		})
		.transform(fresh)
}
