import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const redirectAccountCredits = createServerFn({ method: 'GET' })
	.inputValidator(z.string().regex(/^\/account\/credits(?:\?[^#]*)?$/))
	.handler(async ({ data: href }) => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		const { redirect } = await import('@tanstack/react-router')
		const { accountCreditsRedirectUrl } =
			await import('#app/handlers/account-credits.ts')
		const { personalUsageSlug } = await import('#app/handlers/account-usage.ts')
		try {
			return await withWebsiteRead({}, async ({ user, env, request }) => {
				const slug = await personalUsageSlug(env, user)
				throw redirect({
					href: accountCreditsRedirectUrl(
						new URL(href, request.url).href,
						slug,
					),
					statusCode: 302,
					headers: { 'Cache-Control': 'private, no-store' },
				})
			})
		} catch (error) {
			if (error instanceof WebsiteAuthenticationError)
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(href)}`,
					statusCode: 302,
				})
			throw error
		}
	})
