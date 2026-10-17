import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountUsagePage } from '../../pages/account-usage.tsx'
import { type SessionInfo } from '#client/session.ts'
import {
	type AccountUsageCredits,
	type AccountUsageCreditsWallet,
	type AccountUsageLoaderData,
} from '#universal/loader-data.ts'
import { orgUsagePath } from '#universal/org-pages.ts'
import {
	includedComputeSummary,
	presentIncludedCompute,
	resolveCreditsAlarm,
	toAccountActivity,
} from '#universal/usage-presentation.ts'

const session: SessionInfo = {
	email: 'jane@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'jane',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

const sampleDebitMeters: AccountUsageCreditsWallet['debitMeters'] = [
	{
		meter: 'unique_worker_days',
		label: 'Worker compute',
		unitRateLabel: '$0.004 per worker-compute day',
		include: 350,
		used: 1_995,
		pastInclude: 1_645,
		percentOfInclude: 1_995 / 350,
		estCreditsMicroUsd: 6_580_000,
	},
	{
		meter: 'durable_object_rows_read',
		label: 'Rows read',
		unitRateLabel: '$0.002 per million rows read',
		include: 5_000_000_000,
		used: 1_200_000_000,
		pastInclude: 0,
		percentOfInclude: 1_200_000_000 / 5_000_000_000,
		estCreditsMicroUsd: 0,
	},
]

const pastIncludeFunded = presentIncludedCompute({
	plan: 'pro',
	creditWallet: 'funded',
	meters: [
		{ resource: 'unique_worker_days', current: 1_995, include: 350 },
		{
			resource: 'durable_object_rows_read',
			current: 1_200_000_000,
			include: 5_000_000_000,
		},
	],
})

function wallet(
	overrides: Partial<AccountUsageCreditsWallet> = {},
): AccountUsageCreditsWallet {
	return {
		eligible: true,
		configured: true,
		canSwitchToPro: true,
		canBuyCredits: true,
		balanceMicroUsd: 18_420_000,
		hasCredits: true,
		packsCents: [1_000, 2_500, 5_000],
		customMinCents: 500,
		customMaxCents: 50_000,
		autoRefill: {
			enabled: false,
			thresholdCents: null,
			amountCents: null,
			monthlyCapCents: null,
			minThresholdCents: 500,
			refilledThisMonthCents: 0,
			hasPaymentMethod: false,
		},
		notify: { autoRefilled: true, monthlyCap: true, lowBalance: true },
		limits: [
			{
				resource: 'execute_unique_workers_per_day',
				label: 'Unique execute workers per day',
				included: 500,
				creditsCeiling: 25_000,
			},
		],
		debitMeters: sampleDebitMeters,
		recent: [
			{
				id: 'entry-1',
				kind: 'top_up',
				amountMicroUsd: 25_000_000,
				description: 'Top-up',
				createdAt: '2026-09-20T10:00:00.000Z',
			},
			{
				id: 'entry-2',
				kind: 'debit',
				amountMicroUsd: -6_580_000,
				description: 'Worker compute (1,645)',
				createdAt: '2026-09-21T10:00:00.000Z',
			},
		],
		...overrides,
	}
}

function usage(
	overrides: Partial<AccountUsageLoaderData> & {
		credits?: AccountUsageCredits | null
	} = {},
): AccountUsageLoaderData {
	return {
		ok: true,
		plan: 'pro',
		manualPlan: 'free',
		stripePlan: 'pro',
		today: '2026-09-27',
		weekStart: '2026-09-21',
		entitlementConsumption: [
			{
				resource: 'execute_unique_workers_per_day',
				label: 'Execute calls',
				group: 'daily',
				kind: 'counter',
				whatCounts: 'Execute calls today (UTC).',
				howToReduce: 'Run fewer execute calls today or this week.',
				current: 30,
				limit: 25_000,
				percentOfLimit: 30 / 25_000,
				overEightyPercent: false,
			},
		],
		warnings: [],
		computeOverage: {
			meters: [],
			creditWallet: 'funded',
			creditsStatus: 'debiting_credits',
			creditsCostMicroUsd: 6_580_000,
		},
		canBuyCredits: true,
		activity: toAccountActivity({
			month: '2026-09',
			counts: {
				execute: 4_812,
				job_run: 96,
				workflow_run: 12,
				package_export: 310,
			},
		}),
		includedCompute: pastIncludeFunded,
		includedComputeSummary: includedComputeSummary({
			plan: 'pro',
			creditWallet: 'funded',
			meters: pastIncludeFunded,
		}),
		creditsAlarm: null,
		whereItWent: {
			month: '2026-09',
			totalCreditsMicroUsd: 0,
			rows: [],
		},
		credits: wallet(),
		...overrides,
	}
}

async function renderUsagePage(accountUsage: AccountUsageLoaderData) {
	const html = await renderToString(
		jsx(AccountUsagePage, {
			orgSlug: session.username,
			queryKey: ['page', null, 'loadUsagePage', orgUsagePath(session.username)],
			payload: accountUsage,
			currentHref: orgUsagePath(session.username),
		}),
		orgUsagePath(session.username),
		session,
	)
	const text = html
		.replaceAll(/<style[\s\S]*?<\/style>/g, ' ')
		.replaceAll(/<script[\s\S]*?<\/script>/g, ' ')
		.replaceAll(/<[^>]+>/g, ' ')
	return { html, text }
}

const overHundredPercent = /\b(?:1(?:0[1-9]|[1-9]\d)|[2-9]\d\d|\d{4,})%/

const missing = (html: string, parts: Array<string>) =>
	parts.filter((part) => !html.includes(part))

test('usage page is the one money/caps page: Pro wallet shows balance, packs, limits, rate card, and credit history last', async () => {
	const { html } = await renderUsagePage(usage())
	expect(html).toMatch(
		/<a(?=[^>]*href="\/@jane\/-\/usage")(?=[^>]*aria-current="page")[^>]*>/,
	)
	const order = [
		'Activity this month',
		'Included compute',
		'Daily rates',
		'id="credits"',
		'How far credits go',
		'How credits are charged',
		'Credit history',
	].map((marker) => html.indexOf(marker))
	for (const index of order) expect(index).toBeGreaterThan(-1)
	expect(order).toEqual([...order].sort((a, b) => a - b))
	// Activity and included compute render once, not again inside Credits.
	expect(html.split('Activity this month')).toHaveLength(2)
	expect(
		html.split('data-included-compute-meter="unique_worker_days"'),
	).toHaveLength(2)

	expect(
		missing(html, [
			'$18.42',
			'Usage past your monthly include is charged from these credits.',
			'>$10<',
			'>$25<',
			'>$50<',
			'Custom amount ($)',
			'>Included<',
			'On credits, up to',
			'25,000',
			'data-credits-rate-card',
			'data-credits-rate-card-stack',
			'<table',
			'@media (max-width: 640px)',
			'$0.004 per worker-compute day',
			'$0.002 per million rows read',
			'Monthly include',
			'Used this period',
			'Past include',
			'Est. credits this period',
			'1,645',
			'$6.58',
			'+$25.00',
			'−$6.58',
			'Worker compute (1,645)',
			'Auto-refill',
			'Balance at or below $5',
		]),
	).toEqual([])
	expect(html).not.toContain('Hit monthly cap')
})

test('rate card keeps sub-cent estimated credits visible', async () => {
	const { html } = await renderUsagePage(
		usage({
			credits: wallet({
				debitMeters: [
					{
						meter: 'unique_worker_days',
						label: 'Worker compute',
						unitRateLabel: '$0.004 per worker-compute day',
						include: 350,
						used: 351,
						pastInclude: 1,
						percentOfInclude: 351 / 350,
						estCreditsMicroUsd: 4_000,
					},
				],
				recent: [],
			}),
		}),
	)
	expect(html).toContain('>$0.004<')
	expect(html).toContain('No credit activity yet.')
})

test('auto-refill on shows its settings, cap notices, and the card note', async () => {
	const { html } = await renderUsagePage(
		usage({
			credits: wallet({
				balanceMicroUsd: -120_000,
				hasCredits: false,
				autoRefill: {
					enabled: true,
					thresholdCents: 500,
					amountCents: 2_500,
					monthlyCapCents: 10_000,
					minThresholdCents: 500,
					refilledThisMonthCents: 2_500,
					hasPaymentMethod: false,
				},
			}),
		}),
	)
	expect(
		missing(html, [
			'−$0.12',
			'With no credits left, usage past your monthly include stops. Add credits to keep going.',
			'value="25"',
			'value="100"',
			'Auto-refilled',
			'Hit monthly cap',
			'Auto-refill starts after your first top-up saves a card.',
		]),
	).toEqual([])
	expect(html).not.toContain('Balance at or below $5')
})

test('eligible wallet that cannot buy shows subscribe, not purchase UI', async () => {
	const { html } = await renderUsagePage(
		usage({ credits: wallet({ canBuyCredits: false }) }),
	)
	expect(html).toContain('Subscribe to Pro to add credits.')
	expect(html).not.toContain('Custom amount ($)')
	expect(html).not.toContain('>$25<')
})

test('credits notice from a top-up shows in the Credits section', async () => {
	const { html } = await renderUsagePage(
		usage({
			notice:
				'Credits added. Usage past your monthly include runs on them within a minute.',
		}),
	)
	const notice = html.indexOf('Credits added.')
	expect(notice).toBeGreaterThan(html.indexOf('id="credits"'))
	expect(notice).toBeLessThan(html.indexOf('data-credits-balance'))
})

test('Free sees one short credits CTA with no balance or purchase UI', async () => {
	const { html, text } = await renderUsagePage(
		usage({
			plan: 'free',
			manualPlan: 'free',
			stripePlan: null,
			canBuyCredits: false,
			computeOverage: {
				meters: [],
				creditWallet: 'none',
				creditsStatus: 'within_include',
				creditsCostMicroUsd: 0,
			},
			credits: {
				eligible: false,
				canSwitchToPro: true,
				billingHref: '/account/billing',
			},
		}),
	)
	expect(html).toContain('id="credits"')
	expect(text).toContain('Credits are available on Pro.')
	expect(html).toContain('>Switch to Pro<')
	expect(
		[
			'data-credits-balance',
			'Add credits',
			'Custom amount',
			'Auto-refill',
			'How far credits go',
			'How credits are charged',
			'Credit history',
		].filter((purchase) => html.includes(purchase)),
	).toEqual([])
	expect(text).not.toMatch(overHundredPercent)

	const { html: noCheckout } = await renderUsagePage(
		usage({
			plan: 'free',
			canBuyCredits: false,
			credits: {
				eligible: false,
				canSwitchToPro: false,
				billingHref: '/account/billing',
			},
		}),
	)
	expect(noCheckout).toMatch(/href="\/account\/billing"[^>]*>Go to billing</)
	expect(noCheckout).not.toContain('>Switch to Pro<')
})

test('operator plans have no credits section', async () => {
	const { html, text } = await renderUsagePage(
		usage({ plan: 'max', manualPlan: 'max', stripePlan: null, credits: null }),
	)
	expect(html).not.toContain('id="credits"')
	expect(text).not.toContain('Credits are available on Pro.')
})

test('credits alarm shows once, above the Credits section, linking into it', async () => {
	const pastIncludeEmpty = presentIncludedCompute({
		plan: 'pro',
		creditWallet: 'empty',
		meters: [{ resource: 'unique_worker_days', current: 400, include: 350 }],
	})
	const { html, text } = await renderUsagePage(
		usage({
			includedCompute: pastIncludeEmpty,
			creditsAlarm: resolveCreditsAlarm({
				creditWallet: 'empty',
				meters: pastIncludeEmpty,
				balanceMicroUsd: 0,
				canBuyCredits: true,
				autoRefill: null,
			}),
			credits: wallet({ balanceMicroUsd: 0, hasCredits: false }),
		}),
	)
	expect(html.split('data-credits-alarm=')).toHaveLength(2)
	expect(html).toContain('data-credits-alarm="include_used_no_credits"')
	expect(text).toContain('Runs past the include are stopped')
	expect(html).toMatch(/href="#credits"[^>]*>Add credits</)
	expect(html.indexOf('data-credits-alarm')).toBeLessThan(
		html.indexOf('id="credits"'),
	)
	expect(html).toContain('data-included-compute-tone="attention"')
	expect(text).not.toMatch(overHundredPercent)
})
