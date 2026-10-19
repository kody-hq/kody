import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'

const stableUserIdSchema = z.object({
	stableUserId: z.string().min(1),
})

const deleteSchema = stableUserIdSchema.extend({
	handleConfirmation: z.string(),
	acknowledge: z.boolean(),
})

const approveSchema = z.object({
	approvalId: z.string().uuid(),
	acknowledge: z.boolean(),
})

function actorFromUser(user: AuthenticatedAppUser) {
	return {
		stableUserId: user.mcpUser.userId,
		email: user.email,
		username: user.username,
		roles: user.roles,
	}
}

export const readAdminAccountDeletionSummary = createServerFn({ method: 'GET' })
	.inputValidator(stableUserIdSchema)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		const { readAdminAccountDeletionSummaryForActor } =
			await import('../../src/admin/account-hard-delete.ts')
		return withWebsiteRead({}, async ({ env, user }) =>
			readAdminAccountDeletionSummaryForActor({
				env,
				actor: actorFromUser(user),
				stableUserId: data.stableUserId,
			}),
		)
	})

export const deleteAdminUserAccount = createServerFn({ method: 'POST' })
	.inputValidator(deleteSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteAdminUserAccount } =
			await import('../../src/admin/account-hard-delete.ts')
		return withWebsiteMutation({}, async ({ env, user }) =>
			deleteAdminUserAccount({
				env,
				actor: actorFromUser(user),
				stableUserId: data.stableUserId,
				handleConfirmation: data.handleConfirmation,
				acknowledge: data.acknowledge,
			}),
		)
	})

export const loadAdminAccountDeletionApproval = createServerFn({
	method: 'GET',
})
	.inputValidator(
		z.object({
			approvalId: z.string().uuid(),
			returnTo: z
				.string()
				.regex(/^\/admin\/account-deletions\/[^/?#\\]+(?:\?[^#\\]*)?$/),
		}),
	)
	.handler(async ({ data }) => {
		const [{ readAdminAccountDeletionApproval }, { loadDocumentHead }] =
			await Promise.all([
				import('../../src/admin/account-hard-delete.ts'),
				import('./document-head.ts'),
			])
		const { readAdminPageContext } = await import('./admin-page-context.ts')
		const { bindings, url, user } = await readAdminPageContext(data.returnTo)
		if (!user) {
			return {
				forbidden: true as const,
				head: loadDocumentHead('adminAccountDeletion', data.returnTo),
			}
		}
		const approval = await readAdminAccountDeletionApproval({
			env: bindings,
			approvalId: data.approvalId,
		})
		return {
			forbidden: false as const,
			approval,
			head: loadDocumentHead(
				'adminAccountDeletion',
				url.pathname,
				undefined,
				url.search,
			),
		}
	})

export const approveAdminAccountDeletion = createServerFn({ method: 'POST' })
	.inputValidator(approveSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { approveAdminAccountDeletionForActor } =
			await import('../../src/admin/account-hard-delete.ts')
		return withWebsiteMutation({}, async ({ env, user }) =>
			approveAdminAccountDeletionForActor({
				env,
				actor: actorFromUser(user),
				approvalId: data.approvalId,
				acknowledge: data.acknowledge,
			}),
		)
	})
