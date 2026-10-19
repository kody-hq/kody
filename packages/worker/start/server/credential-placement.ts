import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { credentialFillPlacementViewSchema } from '#universal/credential-fill-placement.ts'

export const saveCredentialPlacement = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			credentialId: z.string().min(1),
			placement: credentialFillPlacementViewSchema.nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setCredentialPlacement } =
			await import('#app/credential-placement-mutation.ts')
		const { requireOperationResult } = await import('#app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async ({ env, user }) =>
				requireOperationResult(
					await setCredentialPlacement({
						env,
						user,
						body: {
							credentialId: data.credentialId,
							placement: data.placement,
						},
					}),
				),
		)
	})
