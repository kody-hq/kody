import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
const tokenSchema = z.object({ token: z.string().min(1).max(300) })
export const loadFileInvitation = createServerFn({ method: 'GET' })
	.validator(tokenSchema)
	.handler(async ({ data }) => {
		const [
			{ loadPersonalCollection },
			{ fileInvitationOffer },
			{ websiteCapabilityContext },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/files/invitations.ts'),
			import('../../src/app/website-capability.ts'),
		])
		const {
			bindings: env,
			request,
			user,
		} = await loadPersonalCollection(
			`/files/invites/${encodeURIComponent(data.token)}`,
		)
		return fileInvitationOffer(
			websiteCapabilityContext({ env, request, user }),
			data.token,
		)
	})
export const acceptFileInvitation = createServerFn({ method: 'POST' })
	.validator(tokenSchema)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ acceptFileInvitation },
			{ websiteCapabilityContext },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/files/invitations.ts'),
			import('../../src/app/website-capability.ts'),
		])
		return withWebsiteMutation({}, async (context) => {
			try {
				return {
					ok: true as const,
					...(await acceptFileInvitation(
						websiteCapabilityContext(context),
						data.token,
					)),
				}
			} catch (error) {
				return {
					ok: false as const,
					message:
						error instanceof Error
							? error.message
							: 'Could not accept this invitation.',
				}
			}
		})
	})
