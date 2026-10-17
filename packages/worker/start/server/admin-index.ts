import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { redirect } from '@tanstack/react-router'

/** Only the matched admin index redirects, after checking the current principal. */
export const loadAdminIndex = createServerFn({ method: 'GET' })
	.validator(
		z.object({ returnTo: z.string().regex(/^\/admin\/?(?:\?[^#\\]*)?$/) }),
	)
	.handler(async ({ data }) => {
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { user } = await readAdminPageContext(data.returnTo)
		if (!user) return { forbidden: true as const }
		throw redirect({ to: '/admin/users', statusCode: 302 })
	})
