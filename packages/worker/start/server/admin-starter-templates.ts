import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const headKeys = {
	list: 'adminStarterTemplates',
	new: 'adminStarterTemplateNew',
	detail: 'adminStarterTemplateDetail',
} as const

export const loadAdminStarterTemplates = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z
				.string()
				.regex(/^\/admin\/starter-templates(?:\/[^/?#\\]+)?(?:\?[^#\\]*)?$/),
			view: z.enum(['list', 'new', 'detail']),
			candidatePackage: z.string().max(200).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ loadAdminStarterTemplatesData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-starter-templates-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead(headKeys[data.view], data.returnTo),
			}
		}
		const payload = await loadAdminStarterTemplatesData(bindings, {
			candidatePackage: data.view === 'new' ? data.candidatePackage : null,
		})
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				headKeys[data.view],
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
