import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminCommunityReports = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z.string().regex(/^\/admin\/community-reports(?:\?[^#\\]*)?$/),
			status: z.string().nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ readAdminCommunityReportsData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-community-reports-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminCommunityReports', data.returnTo),
			}
		}
		const payload = await readAdminCommunityReportsData(bindings, data)
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				'adminCommunityReports',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
