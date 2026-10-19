import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { AdminUserAccountModeration } from './pages/admin-account-delete-dialog.tsx'
import { AdminAccountDeletionApprovalPage } from './pages/admin-account-deletion-approval.tsx'
import { type AdminAccountDeletionSummary } from '#universal/admin-account-deletion.ts'

const summary: AdminAccountDeletionSummary = {
	handle: 'ada-lovelace',
	email: 'ada@example.com',
	createdAt: '2026-01-03T00:00:00.000Z',
	plan: 'pro',
	counts: {
		packages: 2,
		jobs: 1,
		credentials: 3,
		connections: 1,
		sessions: 4,
		orgMemberships: 2,
		memories: 5,
		webhooks: 1,
		usage: 9,
	},
	creditBalanceMicroUsd: 2_500_000,
	acknowledgementRequired: true,
	acknowledgementReasons: ['packages', 'sole_owner', 'paid_billing'],
	soleOwnedNonPersonalOrgs: [{ slug: 'solo-team', otherMemberCount: 1 }],
	deletionBlocked: null,
}

test('admin user moderation offers Delete account next to Suspend', async () => {
	const html = await renderStartPage(
		createElement(AdminUserAccountModeration, {
			stableUserId: 'person',
			username: 'ada-lovelace',
			suspendedAt: null,
			emailOutboundPausedAt: null,
			parentMutating: false,
			onSubmitModerationAction: () => undefined,
			onDeleted: () => undefined,
		}),
		'/admin/users/person',
	)
	expect(html).toContain('Suspend account')
	expect(html).toContain('Delete account')
	expect(html).toContain('data-testid="admin-delete-account"')
	expect(html).toContain('data-testid="admin-delete-account-dialog"')
	expect(html).toContain('data-testid="admin-delete-account-handle"')
	expect(html).toContain('Type ')
	expect(html).toContain('ada-lovelace')
	expect(html).toContain(' to confirm')
	expect(html).toContain('data-testid="admin-delete-account-confirm"')
	expect(html).toContain('disabled=""')
})

test('the approval page shows the summary and the acknowledgement checkbox', async () => {
	const html = await renderStartPage(
		createElement(AdminAccountDeletionApprovalPage, {
			approvalId: '00000000-0000-4000-8000-000000000001',
			currentHref:
				'/admin/account-deletions/00000000-0000-4000-8000-000000000001',
			approval: { status: 'pending', summary },
		}),
		'/admin/account-deletions/00000000-0000-4000-8000-000000000001',
	)
	expect(html).toContain('Delete account')
	expect(html).toContain('@ada-lovelace')
	expect(html).toContain('ada@example.com')
	expect(html).toContain('pro')
	expect(html).toContain('Credentials')
	expect(html).toContain('$2.50')
	expect(html).toContain('data-testid="admin-account-deletion-acknowledge"')
	expect(html).toContain('I acknowledge the consequences listed above.')
	expect(html).toContain('data-testid="admin-account-deletion-approve"')
	expect(html).toContain('Approve')
	expect(html).not.toContain('00000000-0000-4000-8000-000000000001')
})
