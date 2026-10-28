import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { AdminOrgDetailPage } from './pages/admin-orgs.tsx'

const orgId = 'a'.repeat(64)
const memberId = 'b'.repeat(64)

test('organization detail SSR does not render raw ids as visible text', async () => {
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
				softDelete: null,
				plan: {
					manualPlan: 'pro',
					stripePlan: 'pro',
					effectivePlan: 'pro',
					entitlementLadder: 'public',
					stripeCustomerLinked: true,
					adminCreditsEligible: false,
					stripeCreditsEligible: true,
					creditsEligible: true,
				},
				seats: { live: 1, billingOnly: 0 },
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
					recent: [],
				},
				teamsCount: 0,
			},
		}),
		'/admin/orgs/blue-team',
	)
	const visibleText = html.replace(/<[^>]*>/g, ' ')
	expect(visibleText).toContain('Blue Team')
	expect(visibleText).toContain('member')
	expect(visibleText).not.toContain(orgId)
	expect(visibleText).not.toContain(memberId)
})
