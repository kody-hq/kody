import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
import { z } from 'zod'

export const loadCreditsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			cursor: z.string().nullable().optional(),
			search: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		const { loadAuthorizedOrgCredits } =
			await import('#app/org-credits-access.ts')
		const { InvalidCreditLedgerCursorError } =
			await import('#app/org-credits-data.ts')
		const { loadDocumentHead } = await import('./document-head.ts')
		const pathname = `/@${data.orgSlug}/-/credits`
		const search = new URLSearchParams(data.search ?? '')
		if (data.cursor != null) search.set('cursor', data.cursor)
		const href = pathname + (search.size ? `?${search}` : '')
		try {
			return await withWebsiteRead(
				{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
				async ({ env, user }) => {
					const payload = await loadAuthorizedOrgCredits({
						env,
						user,
						cursor: data.cursor,
					})
					if (!payload) throw notFound()
					return {
						payload,
						head: loadDocumentHead(
							'orgCredits',
							pathname,
							{ orgCredits: payload },
							search.toString(),
						),
					}
				},
			)
		} catch (error) {
			if (error instanceof WebsiteAuthenticationError)
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(href)}`,
				})
			if (error instanceof InvalidCreditLedgerCursorError) {
				search.delete('cursor')
				throw redirect({ href: pathname + (search.size ? `?${search}` : '') })
			}
			if (error instanceof Error && error.message === 'Organization not found.')
				throw notFound()
			throw error
		}
	})
