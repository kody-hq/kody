import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'

export const loadConnectionUsagePage = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
	.handler(async ({ data }) => {
		const [{ loadScopedCollection }, { loadAccountConnectionUsageData }] =
			await Promise.all([
				import('./collection-context.ts'),
				import('../../src/app/handlers/account-connection-usage.ts'),
			])
		const { bindings: env, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'agents',
			returnTo: routes.orgAgents.href({ orgSlug: data.orgSlug }),
		})
		return loadAccountConnectionUsageData({ env, user })
	})
