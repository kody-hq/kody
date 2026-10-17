import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminCodemods = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z.string().regex(/^\/admin\/codemods(?:\?[^#\\]*)?$/),
		}),
	)
	.handler(async ({ data }) => {
		const [{ loadAdminCodemodsData }, { loadDocumentHead }] = await Promise.all(
			[
				import('../../src/admin/codemods-operations.ts'),
				import('./document-head.ts'),
			],
		)
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminCodemods', data.returnTo),
			}
		}
		const payload = await loadAdminCodemodsData(bindings)
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				'adminCodemods',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
