import { createElement } from 'react'
import { expect, test } from 'vitest'
import { type OrgCreditsLoaderData } from '#universal/loader-data.ts'
import { orgCreditsPath } from '#universal/org-pages.ts'
import { renderStartPage } from './test-support/render-start-page.ts'
import {
	formatBudgetLine,
	formatLedgerAmount,
	formatLedgerMicroUsd,
	OrgCreditsPage,
} from './pages/org-credits.tsx'
async function renderCreditsPage(payload: OrgCreditsLoaderData) {
	const href = orgCreditsPath(payload.org.slug)
	const html = await renderStartPage(
		createElement(OrgCreditsPage, {
			payload,
			currentHref: href,
			actorKey: 'person-ada',
			orgSlug: payload.org.slug,
		}),
		href,
	)
	expect(html).toContain('aria-label="Workspace sections"')
	expect(html).toContain('href="/@acme/-/credentials"')
	return html
		.replaceAll(/<style[\s\S]*?<\/style>/g, ' ')
		.replaceAll(/<script[\s\S]*?<\/script>/g, ' ')
		.replaceAll(/<[^>]+>/g, ' ')
		.replaceAll(/\s+/g, ' ')
}
const org = { slug: 'acme', displayName: 'Acme', personal: false }

test('sub-cent usage charges keep their value instead of rounding to $0.00', () => {
	expect(formatLedgerAmount(-4_000)).toBe('−$0.004')
	expect(formatLedgerAmount(-1)).toBe('−$0.000001')
	expect(formatLedgerAmount(-12_345)).toBe('−$0.012345')
	expect(formatLedgerAmount(25_000_000)).toBe('+$25.00')
	expect(formatLedgerMicroUsd(38_989_999)).toBe('$38.989999')
	expect(
		formatBudgetLine({ budgetMicroUsd: 20_000_000, spentMicroUsd: 1_500_000 }),
	).toBe('$1.50 of $20.00 spent this month')
	expect(
		formatBudgetLine({ budgetMicroUsd: 20_000_000, spentMicroUsd: null }),
	).toBe('$20.00 per month (spend unavailable right now)')
})

test('billing readers see the balance, budgets, and ledger rows', async () => {
	const text = await renderCreditsPage({
		ok: true,
		org,
		access: 'billing',
		wallet: {
			balanceMicroUsd: 38_990_000,
			creditsEligible: false,
			autoRefillEnabled: false,
			manageHref: '/@acme/-/usage#credits',
			whereItWentHref: '/@acme/-/usage#where-it-went',
		},
		budgets: {
			month: '2026-10',
			yours: null,
			org: { defaultUserBudgetMicroUsd: null, automation: null },
		},
		ledger: {
			entries: [
				{
					id: 'grant-1',
					kind: 'admin_grant',
					typeLabel: 'Grant',
					description: 'Credits granted by Kody',
					detail: null,
					amountMicroUsd: 25_000_000,
					balanceAfterMicroUsd: 38_990_000,
					createdAt: '2026-09-15T00:00:00.000Z',
				},
			],
			nextCursor: 'abc',
		},
	})
	expect(text).toContain('$38.99')
	expect(text).toContain('not on Pro, so the balance is kept')
	expect(text).toContain('Credits granted by Kody')
	expect(text).toContain('+$25.00')
	expect(text).toContain('Load older')
	expect(text).toContain('No monthly budget applies to you.')
})

test('members see their budget and no balance or ledger', async () => {
	const text = await renderCreditsPage({
		ok: true,
		org,
		access: 'member',
		wallet: null,
		ledger: null,
		budgets: {
			month: '2026-10',
			yours: {
				source: 'individual',
				budgetMicroUsd: 3_000_000,
				spentMicroUsd: 400_000,
			},
			org: null,
		},
	})
	expect(text).toContain('$0.40 of $3.00 spent this month (set for you)')
	expect(text).toContain(
		'Owners and billing admins see the balance and ledger.',
	)
	expect(text).not.toContain('Balance after')
	expect(text).not.toContain('Automation budget')
})
