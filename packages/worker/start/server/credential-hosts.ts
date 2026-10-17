import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const saveCredentialHosts = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			credentialId: z.string().min(1),
			hosts: z.array(z.string()),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setCredentialHosts } =
			await import('#app/credential-host-mutation.ts')
		const { requireOperationResult } = await import('#app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async ({ env, user }) =>
				requireOperationResult(
					await setCredentialHosts({ env, user, body: data }),
				),
		)
	})
