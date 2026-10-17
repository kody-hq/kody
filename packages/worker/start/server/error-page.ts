import { createServerFn } from '@tanstack/react-start'

export const loadInternalErrorPage = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [{ setResponseStatus }, { loadDocumentHead }] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('./document-head.ts'),
		])
		setResponseStatus(500)
		return { head: loadDocumentHead('internalErrorPage', '/500') }
	},
)

export const loadNotFoundPage = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [{ setResponseStatus }, { loadDocumentHead }] = await Promise.all([
			import('@tanstack/react-start/server'),
			import('./document-head.ts'),
		])
		setResponseStatus(404)
		return { head: loadDocumentHead('notFoundPage', '/404') }
	},
)
