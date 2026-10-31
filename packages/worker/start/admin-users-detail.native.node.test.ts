import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { AdminUserDetail } from './pages/admin-users-detail.tsx'
import { type AdminUserListItem } from '#universal/loader-data.ts'

test('user detail exposes organization billing and no user billing forms', async () => {
	const stableUserId = 'a'.repeat(64)
	const html = await renderStartPage(
		createElement(AdminUserDetail, {
			selectedUser: {
				stableUserId,
				username: 'fake-user',
				email: 'fake-user@example.com',
				email_verified: true,
				email_verified_at: '2026-01-01T00:00:00.000Z',
				plan: 'pro',
				manualPlan: 'free',
				stripePlan: 'pro',
				effectivePlan: 'pro',
				secondAgentGiftExpiresAt: null,
				referralCreditExpiresAt: null,
				overlayExpiresAt: null,
				isProOverlay: false,
				overlayType: null,
				entitlementLadder: 'legacy',
				stripeCustomerLinked: true,
				suspended_at: null,
				deleted_at: null,
				deleting_at: null,
				email_outbound_paused_at: null,
				email_verification_delivery: null,
				email_verification_delivery_detail: null,
				utm_source: null,
				utm_medium: null,
				utm_campaign: null,
				utm_content: null,
				utm_term: null,
				first_touch_landing_path: null,
				first_touch_referrer: null,
				first_mcp_connected_at: null,
				first_execute_at: null,
				first_search_at: null,
				first_saved_package_at: null,
				mcp_client_name: null,
				last_active_at: null,
				created_at: '2026-01-01T00:00:00.000Z',
				updated_at: '2026-01-01T00:00:00.000Z',
				roles: ['user'],
			} as AdminUserListItem,
			orgs: [
				{
					orgId: stableUserId,
					slug: 'fake-personal',
					displayName: null,
					kind: 'personal',
					role: 'owner',
					effectivePlan: 'pro',
					seats: 1,
					membershipDeletedAt: null,
					orgDeletedAt: null,
				},
			],
			availableRoles: ['user'],
			actionState: 'idle',
			selectedRoleToAssign: 'user',
			mintedVerifyUrl: null,
			mintedVerifyUrlForStableUserId: null,
			usageStatus: 'loading',
			usageMessage: null,
			usageFailedForStableUserId: null,
			selectedUsage: null,
			onRoleToAssignChange: () => {},
			onSubmitRoleAction: () => {},
			onSubmitVerificationAction: () => {},
			onSubmitModerationAction: () => {},
			onAccountDeleted: () => {},
		}),
		`/admin/users/${stableUserId}`,
	)
	expect(html).toContain('Billing')
	expect(html).toContain('Open personal organization')
	expect(html).toContain('/admin/orgs/fake-personal')
	expect(html).not.toContain('Admin grant')
	const billingPanel = html.split('Billing')[1]?.split('Moderation')[0] ?? ''
	expect(billingPanel).not.toMatch(/<form/)
})
