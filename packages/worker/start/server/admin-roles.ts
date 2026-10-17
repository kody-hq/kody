import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminRoles = createServerFn({ method: 'GET' })
	.validator(
		z.object({ returnTo: z.string().regex(/^\/admin\/roles(?:\?[^#\\]*)?$/) }),
	)
	.handler(async ({ data }) => {
		const [{ loadAdminRolesData }, { loadDocumentHead }] = await Promise.all([
			import('../../src/app/admin-roles-data.ts'),
			import('./document-head.ts'),
		])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminRoles', data.returnTo),
			}
		}
		const payload = await loadAdminRolesData(bindings)
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead('adminRoles', url.pathname, undefined, url.search),
		}
	})
