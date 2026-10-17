import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { adminUsersReadInput } from './admin-users-input.ts'

export const loadAdminUsers = createServerFn({ method: 'GET' })
	.validator(
		adminUsersReadInput.extend({
			selectedStableUserId: z.string().nullable(),
			detail: z.boolean(),
			returnTo: z
				.string()
				.regex(/^\/admin\/users(?:\/[^/?#\\]+)?(?:\?[^#\\]*)?$/),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ readAdminUsersData },
			{ loadDocumentHead },
			{ readAdminPageContext },
		] = await Promise.all([
			import('../../src/admin/users-data.ts'),
			import('./document-head.ts'),
			import('./admin-page-context.ts'),
		])
		const { bindings, user } = await readAdminPageContext(data.returnTo)
		const head = loadDocumentHead(
			data.detail ? 'adminUserDetail' : 'adminUsers',
			data.returnTo,
		)
		if (!user) return { forbidden: true as const, head }
		return {
			forbidden: false as const,
			payload: await readAdminUsersData(bindings, {
				query: data.query,
				role: data.role,
				verification: data.verification,
				pageSize: data.pageSize,
				selectedStableUserId: data.selectedStableUserId,
				page: 1,
			}),
			head,
		}
	})
