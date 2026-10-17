import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminSystemEmail = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z.string().regex(/^\/admin\/system-email(?:\?[^#\\]*)?$/),
			page: z.number().int().positive(),
			pageSize: z.number().int().positive().max(100),
			messageId: z.string().nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ readAdminSystemEmailData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/admin/system-email-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, request, url, user } = await readAdminPageContext(
			data.returnTo,
		)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminSystemEmail', data.returnTo),
			}
		}
		const payload = await readAdminSystemEmailData(bindings, data)
		const { auditSystemEmailAccess } =
			await import('../../src/admin/system-email-operations.ts')
		await auditSystemEmailAccess({
			env: bindings,
			request,
			actorEmail: user.email,
			action: payload.selectedMessage
				? 'adminSystemEmailGet'
				: 'adminSystemEmailList',
			reason: payload.selectedMessage
				? `target_message_id=${payload.selectedMessage.id}`
				: 'system_email_list',
		})
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				'adminSystemEmail',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
