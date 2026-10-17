import { createMiddleware } from '@tanstack/react-start'

/** Keep route representations distinct, including redirects and errors. */
export function withNegotiatedDocumentVary(response: Response) {
	const values =
		response.headers
			.get('Vary')
			?.toLowerCase()
			.split(',')
			.map((value) => value.trim()) ?? []
	if (values.includes('accept') || values.includes('*')) return response
	const headers = new Headers(response.headers)
	headers.append('Vary', 'Accept')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export const negotiatedDocument = createMiddleware().server(
	async ({ next }) => {
		const result = await next()
		return { ...result, response: withNegotiatedDocumentVary(result.response) }
	},
)
