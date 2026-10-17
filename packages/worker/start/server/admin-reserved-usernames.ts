import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminReservedUsernames = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z.string().regex(/^\/admin\/reserved-usernames(?:\?[^#\\]*)?$/),
		}),
	)
	.handler(async ({ data }) => {
		const [{ loadAdminReservedUsernamesData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-reserved-usernames-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminReservedUsernames', data.returnTo),
			}
		}
		const payload = await loadAdminReservedUsernamesData(bindings)
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				'adminReservedUsernames',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
