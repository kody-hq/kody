import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { AdminOrgDetailPage } from './pages/admin-orgs.tsx'

const orgId = 'a'.repeat(64)
const memberId = 'b'.repeat(64)
const billingMemberId = 'c'.repeat(64)
const deletedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const restoreDeadline = new Date(
	Date.parse(deletedAt) + 30 * 24 * 60 * 60 * 1000,
).toISOString()

test('organization detail SSR uses admin labels and hides raw ids', async () => {
	const html = await renderStartPage(
		createElement(AdminOrgDetailPage, {
			currentHref: '/admin/orgs/blue-team',
			payload: {
				org: {
					id: orgId,
					slug: 'blue-team',
					displayName: 'Blue Team',
					kind: 'team',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					suspendedAt: null,
				},
				softDelete: {
					deletedAt,
					deletingAt: deletedAt,
					restoreDeadline,
				},
				plan: {
					manualPlan: 'pro',
					stripePlan: 'pro',
					effectivePlan: 'pro',
					entitlementLadder: 'legacy',
					stripeCustomerLinked: false,
					adminCreditsEligible: false,
					stripeCreditsEligible: true,
					creditsEligible: true,
				},
				seats: { live: 2, billingOnly: 1 },
				members: [
					{
						stableUserId: memberId,
						username: 'member',
						role: 'owner',
						joinedAt: '2026-01-01T00:00:00.000Z',
						membershipDeletedAt: null,
						userDeletedAt: null,
						individualBudgetMicroUsd: null,
						effectiveBudgetMicroUsd: null,
					},
					{
						stableUserId: billingMemberId,
						username: 'billing',
						role: 'billing',
						joinedAt: '2026-01-01T00:00:00.000Z',
						membershipDeletedAt: null,
						userDeletedAt: null,
						individualBudgetMicroUsd: null,
						effectiveBudgetMicroUsd: null,
					},
				],
				budgets: {
					defaultUserBudgetMicroUsd: null,
					automationBudgetMicroUsd: null,
				},
				wallet: {
					plan: 'pro',
					eligible: true,
					adminCreditsEligible: false,
					unlocked: false,
					balanceMicroUsd: 0,
					recent: [
						{
							kind: 'admin_grant',
							amountMicroUsd: 1000000,
							description: 'Fake fixture grant',
							createdAt: '2026-01-02T00:00:00.000Z',
							grantedByUsername: 'admin',
							note: null,
						},
					],
				},
				teamsCount: 0,
			},
		}),
		'/admin/orgs/blue-team',
	)
	const visibleText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
	expect(visibleText).toContain('Blue Team')
	expect(visibleText).toContain('member')
	expect(visibleText).toContain('Owner')
	expect(visibleText).toContain('Billing')
	expect(visibleText).toContain('Admin grant')
	expect(visibleText).not.toContain('admin_grant')
	expect(visibleText).toContain('Legacy')
	expect(visibleText).toContain('Stripe customer')
	expect(visibleText).toContain('Not linked')
	expect(visibleText).toContain(
		'2 seats (owners and members) · 1 billing-only member',
	)
	expect(visibleText).toContain('This organization is deleted.')
	expect(visibleText).not.toContain(orgId)
	expect(visibleText).not.toContain(memberId)
	expect(visibleText).not.toContain(billingMemberId)
})
