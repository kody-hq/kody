import { createServerFn } from '@tanstack/react-start'

export const loadAdminFeatureFlags = createServerFn({ method: 'GET' }).handler(
	async () => {
		const [{ loadAdminFeatureFlagsData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-feature-flags-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, user } = await readAdminPageContext(
			'/admin/feature-flags',
		)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminFeatureFlags', '/admin/feature-flags'),
			}
		}
		return {
			forbidden: false as const,
			payload: await loadAdminFeatureFlagsData(bindings),
			head: loadDocumentHead('adminFeatureFlags', '/admin/feature-flags'),
		}
	},
)
