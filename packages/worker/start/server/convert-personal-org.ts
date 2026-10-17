import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const convertPersonalOrganization = createServerFn({ method: 'POST' })
	.validator(
		z.strictObject({
			newHandle: z.string().trim().min(1),
			confirmation: z.string().trim().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ convertPersonalOrg, ConvertPersonalOrgError },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/orgs/convert-personal-org.ts'),
		])
		return withWebsiteMutation({}, async ({ env, user }) => {
			if (
				data.confirmation.toLowerCase() !==
				`convert @${user.username.trim().toLowerCase()}`
			)
				throw new Error(`Type convert @${user.username} to confirm.`)
			try {
				const result = await convertPersonalOrg({
					env,
					personId: user.mcpUser.userId,
					newHandle: data.newHandle,
				})
				return {
					ok: true as const,
					convertedSlug: result.convertedSlug,
					newUsername: result.newUsername,
					followUpFailures: result.followUpFailures,
				}
			} catch (error) {
				if (error instanceof ConvertPersonalOrgError)
					return { ok: false as const, error: error.message, code: error.code }
				throw error
			}
		})
	})
