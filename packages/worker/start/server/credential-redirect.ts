import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

export const redirectCredentialEntry = createServerFn({ method: 'GET' })
	.inputValidator((href: string) => {
		if (
			typeof href !== 'string' ||
			!/^\/(connect\/credential|account\/credentials)(?:\?[^#]*)?$/.test(href)
		)
			throw new Error('Invalid credential entry URL.')
		return href
	})
	.handler(async ({ data: href }) => {
		const { withWebsiteRead, WebsiteAuthenticationError } =
			await import('./mutation-context.ts')
		const { signupOrgCredentialCreateHref } =
			await import('#app/handlers/connect-credential.ts')
		const { orgResourcePath } = await import('#universal/org-pages.ts')
		const url = new URL(href, 'https://kody.local')
		try {
			return await withWebsiteRead({}, async ({ user }) => {
				const destination =
					url.pathname === '/connect/credential'
						? signupOrgCredentialCreateHref(user, url.search)
						: orgResourcePath(
								user.request.org.slug || user.username,
								'credentials',
							) + url.search

				throw redirect({
					href: destination,
					statusCode: 302,
					headers: { 'Cache-Control': 'private, no-store' },
				})
			})
		} catch (error) {
			if (error instanceof WebsiteAuthenticationError)
				throw redirect({
					href: `/login?redirectTo=${encodeURIComponent(href)}`,
					statusCode: 302,
					headers: { 'Cache-Control': 'private, no-store' },
				})
			throw error
		}
	})
