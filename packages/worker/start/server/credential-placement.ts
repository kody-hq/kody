import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { credentialFillPlacementViewSchema } from '#universal/credential-fill-placement.ts'
import { placementApprovalParts } from '#universal/credential-placement-approval.ts'

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

export const approveCredentialPlacementRequest = createServerFn({
	method: 'POST',
})
	.inputValidator(
		z.object({
			orgSlug: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/)
				.optional(),
			names: z.array(z.string().min(1)).min(1).max(20),
			parts: z.array(z.enum(placementApprovalParts)).min(1),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { approveCredentialPlacement } =
			await import('#app/credential-placement-approval.ts')
		const { requireOperationResult } = await import('#app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async ({ env, user }) =>
				requireOperationResult(
					await approveCredentialPlacement({
						env,
						user,
						names: data.names,
						parts: data.parts,
					}),
				),
		)
	})
