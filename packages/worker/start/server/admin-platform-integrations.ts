import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminPlatformIntegrations = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z
				.string()
				.regex(
					/^\/admin\/platform-integrations(?:\/[^/?#\\]+)?(?:\?[^#\\]*)?$/,
				),
			view: z.enum(['list', 'new', 'detail']),
		}),
	)
	.handler(async ({ data }) => {
		const [{ loadAdminPlatformIntegrationsData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-platform-integrations-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead(
					data.view === 'new'
						? 'adminPlatformIntegrationNew'
						: data.view === 'detail'
							? 'adminPlatformIntegrationDetail'
							: 'adminPlatformIntegrations',
					data.returnTo,
				),
			}
		}
		const payload = await loadAdminPlatformIntegrationsData(bindings)
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				data.view === 'new'
					? 'adminPlatformIntegrationNew'
					: data.view === 'detail'
						? 'adminPlatformIntegrationDetail'
						: 'adminPlatformIntegrations',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
