import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { sessionStuckKinds } from '#universal/session-analytics.ts'

const href = '/admin/insights/sessions'

export const loadAdminSessionInsights = createServerFn({
	method: 'GET',
}).handler(async () => {
	const [{ loadAdminSessionInsights }, { loadDocumentHead }] =
		await Promise.all([
			import('../../src/session-analytics/insights.ts'),
			import('./document-head.ts'),
		])
	const { readAdminPageContext } = await import('./admin-page-context.ts')
	const { bindings, user } = await readAdminPageContext(href)
	const head = loadDocumentHead('adminSessionInsights', href)
	if (!user) return { forbidden: true as const, head }
	return {
		forbidden: false as const,
		payload: await loadAdminSessionInsights(bindings.APP_DB, new Date()),
		head,
	}
})

export const markAdminSessionPatternFixed = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			categoryId: z.string().min(1),
			stuckKind: z.enum(sessionStuckKinds),
			stuckTool: z.string().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { markAdminSessionPatternFixed } =
			await import('../../src/admin/session-insights-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			markAdminSessionPatternFixed({ request, env, fields: data }),
		)
	})

export const retireAdminSessionCategory = createServerFn({ method: 'POST' })
	.validator(z.object({ categoryId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { retireAdminSessionCategory } =
			await import('../../src/admin/session-insights-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			retireAdminSessionCategory({ request, env, fields: data }),
		)
	})
