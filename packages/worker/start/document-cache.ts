import { createMiddleware } from '@tanstack/react-start'
import type {} from './document-cache-policy.ts'
export const documentCache = createMiddleware().server(
	async ({ request, next }) => {
		const { serveNativeDocument } = await import('#start/server/document-cache')
		return serveNativeDocument(request, async () => (await next()).response)
	},
)
