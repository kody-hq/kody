import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const loadAdminPlatformFeedback = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			returnTo: z.string().regex(/^\/admin\/platform-feedback(?:\?[^#\\]*)?$/),
			page: z.number().int().positive(),
			pageSize: z.number().int().positive().max(100),
			status: z.string().nullable(),
			category: z.string().nullable(),
			feedbackId: z.string().nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ readAdminPlatformFeedbackData }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/app/admin-platform-feedback-data.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, request, url, user } = await readAdminPageContext(
			data.returnTo,
		)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminPlatformFeedback', data.returnTo),
			}
		}
		const payload = await readAdminPlatformFeedbackData(bindings, data)
		const { auditPlatformFeedbackRead } =
			await import('../../src/admin/platform-feedback-operations.ts')
		const { readAdminPlatformFeedbackId } =
			await import('../../src/app/admin-platform-feedback-data.ts')
		const feedbackId = readAdminPlatformFeedbackId(data.feedbackId)
		await auditPlatformFeedbackRead({
			env: bindings,
			request,
			actorEmail: user.email,
			action: feedbackId
				? 'adminPlatformFeedbackGet'
				: 'adminPlatformFeedbackList',
			feedbackId,
			notFound: feedbackId !== null && payload.selectedFeedback === null,
		})
		return {
			forbidden: false as const,
			payload,
			head: loadDocumentHead(
				'adminPlatformFeedback',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})
