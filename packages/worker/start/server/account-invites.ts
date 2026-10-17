import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const acceptPendingInvite = createServerFn({ method: 'POST' })
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { acceptWebsiteInvite } =
			await import('../../src/app/handlers/account-invites.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			resultWithRedirect(
				requireOperationResult(
					await acceptWebsiteInvite({ ...context, inviteId: data.id }),
				),
			),
		)
	})
export const declinePendingInvite = createServerFn({ method: 'POST' })
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { declineWebsiteInvite } =
			await import('../../src/app/handlers/account-invites.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			resultWithRedirect(
				requireOperationResult(
					await declineWebsiteInvite({ ...context, inviteId: data.id }),
				),
			),
		)
	})
export const acceptPendingInviteLink = createServerFn({ method: 'POST' })
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { acceptWebsiteInviteLink } =
			await import('../../src/app/handlers/org-invite-join.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			resultWithRedirect(
				requireOperationResult(
					await acceptWebsiteInviteLink({ ...context, linkId: data.id }),
				),
			),
		)
	})
export const declinePendingInviteLink = createServerFn({ method: 'POST' })
	.validator(z.object({ id: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { declineWebsiteInviteLink } =
			await import('../../src/app/handlers/org-invite-join.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			resultWithRedirect(
				requireOperationResult(
					await declineWebsiteInviteLink({ ...context, linkId: data.id }),
				),
			),
		)
	})
function resultWithRedirect(result: { ok: true }) {
	return {
		ok: true as const,
		redirectTo:
			'redirectTo' in result && typeof result.redirectTo === 'string'
				? result.redirectTo
				: undefined,
	}
}
