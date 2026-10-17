import { createServerFn } from '@tanstack/react-start'

export const loadAdminInsights = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [{ loadAdminInsightsData }, { loadDocumentHead }] = await Promise.all(
			[
				import('../../src/app/admin-insights-data.ts'),
				import('./document-head.ts'),
			],
		)
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, user } = await readAdminPageContext('/admin/insights')
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminInsights', '/admin/insights'),
			}
		}
		return {
			forbidden: false as const,
			payload: await loadAdminInsightsData(bindings),
			head: loadDocumentHead('adminInsights', '/admin/insights'),
		}
	},
)
