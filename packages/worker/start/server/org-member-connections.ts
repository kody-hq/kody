import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)

export const loadOrgAppMemberConnectionsFn = createServerFn({ method: 'GET' })
	.validator(z.object({ orgSlug, appSlug: z.string().min(1) }))
	.handler(async ({ data }) => {
		const [{ withWebsiteRead }, { loadOrgAppMemberConnections }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/app/handlers/org-member-connections.ts'),
			])
		return withWebsiteRead({ scope: { orgSlug: data.orgSlug } }, (context) =>
			loadOrgAppMemberConnections({ ...context, appSlug: data.appSlug }),
		)
	})

export const revokeOrgAppMemberConnectionFn = createServerFn({
	method: 'POST',
})
	.validator(z.object({ orgSlug, credentialId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ revokeOrgAppMemberConnection },
			{ requireOperationResult },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/handlers/org-member-connections.ts'),
			import('../../src/app/operation-result.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await revokeOrgAppMemberConnection({
						...context,
						credentialId: data.credentialId,
					}),
				),
		)
	})
