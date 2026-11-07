import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const credentialId = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..')

/** Turns raw RSA signing on or off for one signing credential. Owner only. */
export const saveCredentialRawSigning = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, credentialId, enabled: z.boolean() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setCredentialRawSigning } =
			await import('#app/credential-raw-signing.ts')
		const { requireOperationResult } = await import('#app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async ({ env, user }) =>
				requireOperationResult(
					await setCredentialRawSigning({
						env,
						user,
						credentialId: data.credentialId,
						enabled: data.enabled,
					}),
				),
		)
	})
