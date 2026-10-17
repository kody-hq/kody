import { createServerFn } from '@tanstack/react-start'

export const loadAdminProviderMarks = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [{ loadAdminProviderMarksData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-provider-marks-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, user } = await readAdminPageContext(
			'/admin/provider-marks',
		)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminProviderMarks', '/admin/provider-marks'),
			}
		}
		return {
			forbidden: false as const,
			payload: await loadAdminProviderMarksData(bindings),
			head: loadDocumentHead('adminProviderMarks', '/admin/provider-marks'),
		}
	},
)
