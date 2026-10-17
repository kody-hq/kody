import { createElement as jsx } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { warningOffersCredits } from '#universal/compute-overage.ts'
import { expect, test } from 'vitest'
import { type SessionInfo } from '#client/session.ts'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
} from '#universal/loader-data.ts'
import { orgUsagePath } from '#universal/org-pages.ts'
import {
	includedComputeSummary,
	presentIncludedCompute,
	resolveCreditsAlarm,
	toAccountActivity,
} from '#universal/usage-presentation.ts'
import {
	AccountUsagePage,
	UsageResourceName,
	accountUsageWarningsPanelTitle,
	formatEntitlementUsedPercent,
	hasReachedEntitlementLimit,
	hotterUsagePercent,
} from './pages/account-usage.tsx'
import { creditsActionForWallet } from '#client/routes/account-usage-shared.ts'

function entitlement(
	overrides: Partial<AccountUsageEntitlementConsumption> = {},
): AccountUsageEntitlementConsumption {
	return {
		resource: 'execute_unique_workers_per_day',
		label: 'unique execute workers per day',
		group: 'daily',
		kind: 'counter',
		whatCounts: 'Execute calls today (UTC).',
		howToReduce: 'Run fewer execute calls today or this week.',
		current: 30,
		limit: 150,
		percentOfLimit: 0.2,
		overEightyPercent: false,
		...overrides,
	}
}

function overage(
	overrides: Partial<AccountUsageComputeOverage> & {
		percentOfLimit?: number
	},
): AccountUsageComputeOverage {
	const { percentOfLimit = 0.9, ...rest } = overrides
	return {
		meters: [
			{
				resource: 'unique_worker_days',
				label: 'Worker compute',
				whatCounts: 'Counts each distinct worker once per UTC day.',
				howToReduce: 'Keep package code stable.',
				current: 45,
				include: 50,
				percentOfLimit,
				overEightyPercent: percentOfLimit >= 0.8,
				creditsStatus: percentOfLimit >= 1 ? 'add_credits' : 'within_include',
			},
			{
				resource: 'durable_object_rows_read',
				label: 'Rows read',
				whatCounts: 'SQLite rows read by Durable Object package storage.',
				howToReduce: 'Read less from package storage.',
				current: 450_000_000,
				include: 500_000_000,
				percentOfLimit: Math.min(percentOfLimit, 0.9),
				overEightyPercent: percentOfLimit >= 0.8,
				creditsStatus: 'within_include',
			},
		],
		creditWallet: 'empty',
		creditsStatus: 'within_include',
		creditsCostMicroUsd: 0,
		...rest,
	}
}

const week = (current: number, limit: number) => ({
	current,
	limit,
	percentOfLimit: current / limit,
	overEightyPercent: current / limit >= 0.8,
})

test('credits action follows the wallet: add, switch, subscribe, or nothing', () => {
	const creditsHref = '/@danj/-/usage#credits'
	const add = { label: 'Add credits', href: creditsHref }
	const switchToPro = { label: 'Switch to Pro', href: creditsHref }
	const subscribe = {
		label: 'Subscribe to Pro',
		href: creditsHref,
	}
	const cases = [
		['empty', 'pro', true, add],
		['none', 'standard', false, switchToPro],
		['none', 'pro', false, switchToPro],
		['empty', 'pro', false, subscribe],
		['funded', 'pro', true, null],
		['none', 'max', false, null],
	] as const
	expect(
		cases.map(([wallet, plan, canBuy]) => [
			wallet,
			plan,
			canBuy,
			creditsActionForWallet(wallet, plan, canBuy, creditsHref),
		]),
	).toEqual(cases)
})

test('warning credits links only on limits credits can raise', () => {
	const raisable = [
		'execute_unique_workers_per_day',
		'outbound_fetches_per_day',
		'job_runs_per_day',
		'automation_invocations_per_day',
		'unique_worker_days',
		'durable_object_rows_read',
	]
	const fixed = [
		'saved_packages',
		'secrets',
		'email_sends_per_day',
		'storage_bytes',
		'concurrent_workflows',
	]
	expect(
		raisable.filter((resource) => !warningOffersCredits(resource)),
	).toEqual([])
	expect(fixed.filter(warningOffersCredits)).toEqual([])
})

test('hotterUsagePercent and formatEntitlementUsedPercent use the closer of daily and weekly windows', () => {
	const hotWeek = entitlement({ week: week(360, 400) })
	expect(hotterUsagePercent(entitlement())).toBe(0.2)
	expect(hotterUsagePercent(hotWeek)).toBe(0.9)
	expect(
		hotterUsagePercent(
			entitlement({ percentOfLimit: 0.95, week: week(100, 400) }),
		),
	).toBe(0.95)
	expect(
		hotterUsagePercent(entitlement({ percentOfLimit: null, week: undefined })),
	).toBeNull()
	expect(formatEntitlementUsedPercent(entitlement())).toBe('20%')
	expect(formatEntitlementUsedPercent(hotWeek)).toBe(
		'20% today · 90% this week',
	)
})

test('usage resource name keeps the explanation in a popover', async () => {
	const whatCounts = 'MCP execute tool runs today (UTC).'
	const html = await renderToString(
		jsx(UsageResourceName, {
			id: 'execute_unique_workers_per_day',
			label: 'Execute calls',
			whatCounts,
			howToReduce: 'Run fewer execute calls today or this week.',
			note: 'High daily headroom for bursts; the weekly total keeps it sustainable.',
		}),
	)
	expect(html).toContain('>Execute calls</span>')
	expect(html).toMatch(
		/popovertarget="usage-resource-execute_unique_workers_per_day"/i,
	)
	expect(html).toContain('aria-label="What counts toward Execute calls"')
	const panelAt = html.indexOf(
		'data-usage-resource-panel="execute_unique_workers_per_day"',
	)
	expect(panelAt).toBeGreaterThan(-1)
	expect(html.slice(panelAt)).toContain(whatCounts)
	expect(html.slice(0, panelAt)).not.toContain(whatCounts)
})

test('warnings panel title is Limit reached at 100% daily or weekly', () => {
	const dailyNearLimit = entitlement({
		percentOfLimit: 0.85,
		overEightyPercent: true,
	})
	expect(accountUsageWarningsPanelTitle([dailyNearLimit])).toBe(
		'Approaching limits',
	)
	expect(hasReachedEntitlementLimit(dailyNearLimit)).toBe(false)

	const weeklyAtLimit = entitlement({
		percentOfLimit: 0.2,
		overEightyPercent: true,
		week: week(400, 400),
	})
	expect(hasReachedEntitlementLimit(weeklyAtLimit)).toBe(true)
	expect(accountUsageWarningsPanelTitle([weeklyAtLimit])).toBe('Limit reached')

	expect(
		accountUsageWarningsPanelTitle([
			entitlement({
				percentOfLimit: 1,
				overEightyPercent: true,
			}),
		]),
	).toBe('Limit reached')

	const computeIncludeAtLimit = entitlement({
		resource: 'durable_object_rows_read',
		group: 'monthly',
		percentOfLimit: 1,
		overEightyPercent: true,
	})
	expect(hasReachedEntitlementLimit(computeIncludeAtLimit)).toBe(false)
	expect(accountUsageWarningsPanelTitle([computeIncludeAtLimit])).toBe(
		'Approaching limits',
	)
	expect(
		accountUsageWarningsPanelTitle([computeIncludeAtLimit, weeklyAtLimit]),
	).toBe('Limit reached')
})

const session: SessionInfo = {
	email: 'danj@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'danj',
	avatarUrl: null,
	roles: [],
	permissions: [],
	featureFlags: {} as SessionInfo['featureFlags'],
}

function usagePage(input: {
	plan: AccountUsageLoaderData['plan']
	computeOverage: AccountUsageComputeOverage
	balanceMicroUsd?: number
	canBuyCredits?: boolean
	entitlementConsumption?: Array<AccountUsageEntitlementConsumption>
	warnings?: Array<AccountUsageEntitlementConsumption>
}): AccountUsageLoaderData {
	const includedCompute = presentIncludedCompute({
		plan: input.plan,
		creditWallet: input.computeOverage.creditWallet,
		meters: input.computeOverage.meters,
	})
	const canBuyCredits = input.canBuyCredits ?? false
	return {
		ok: true,
		plan: input.plan,
		manualPlan: input.plan,
		stripePlan: null,
		today: '2026-09-27',
		weekStart: '2026-09-21',
		entitlementConsumption: input.entitlementConsumption ?? [entitlement()],
		warnings: input.warnings ?? [],
		computeOverage: input.computeOverage,
		canBuyCredits,
		activity: toAccountActivity({
			month: '2026-09',
			counts: { execute: 140, job_run: 3 },
		}),
		includedCompute,
		includedComputeSummary: includedComputeSummary({
			plan: input.plan,
			creditWallet: input.computeOverage.creditWallet,
			meters: includedCompute,
		}),
		creditsAlarm: resolveCreditsAlarm({
			creditWallet: input.computeOverage.creditWallet,
			meters: includedCompute,
			balanceMicroUsd: input.balanceMicroUsd ?? 0,
			canBuyCredits,
			autoRefill: null,
		}),
		whereItWent: {
			month: '2026-09',
			totalCreditsMicroUsd: 0,
			rows: [],
		},
		credits: null,
	}
}

async function renderUsagePage(
	accountUsage: AccountUsageLoaderData,
	orgSlug = session.username,
) {
	const html = await renderToString(
		jsx(AccountUsagePage, {
			orgSlug,
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

test('Free usage page: activity and execute caps lead; Worker compute is informational, never a mega-%', async () => {
	const freeOverage = overage({
		creditWallet: 'none',
		creditsStatus: 'switch_to_pro',
	})
	freeOverage.meters[0] = {
		...freeOverage.meters[0]!,
		current: 517,
		include: 50,
		percentOfLimit: 517 / 50,
		overEightyPercent: true,
		creditsStatus: 'switch_to_pro',
	}
	const { html, text } = await renderUsagePage(
		usagePage({ plan: 'free', computeOverage: freeOverage }),
	)
	expect(text).toContain('Activity this month')
	expect(text).toContain('Code executions')
	expect(text).toContain('Free is limited by daily and weekly execute caps')
	expect(text).toContain('Behind the scenes')
	expect(text).toContain('517 worker-compute days this month')
	expect(text).toContain('Informational · never charged on Free')
	expect(html).not.toContain('data-included-compute-bar')
	expect(html).not.toContain('data-credits-alarm')
	expect(text).not.toMatch(overHundredPercent)
	expect(html.indexOf('Activity this month')).toBeLessThan(
		html.indexOf('Behind the scenes'),
	)
})

test('Pro usage page past include matches credits: capped bar, dollars on credits, no alarm', async () => {
	const fundedOverage = overage({
		creditWallet: 'funded',
		creditsStatus: 'debiting_credits',
		creditsCostMicroUsd: 173_672_000,
	})
	fundedOverage.meters[0] = {
		...fundedOverage.meters[0]!,
		current: 43_768,
		include: 350,
		percentOfLimit: 43_768 / 350,
		overEightyPercent: true,
		creditsStatus: 'debiting_credits',
	}
	const { html, text } = await renderUsagePage(
		usagePage({
			plan: 'pro',
			computeOverage: fundedOverage,
			balanceMicroUsd: 40_000_000,
			canBuyCredits: true,
		}),
	)
	expect(text).toContain('Included compute')
	expect(html).toContain('data-included-compute-bar="100"')
	expect(text).toContain('Include used · $173.67 on credits')
	expect(text).toContain('43,768 of 350 worker-compute days included')
	expect(html).not.toContain('data-credits-alarm')
	expect(text).not.toMatch(overHundredPercent)
})

test('usage links use the explicit route organization instead of the presentation href', async () => {
	const { html } = await renderUsagePage(
		usagePage({ plan: 'free', computeOverage: overage({}) }),
		'selected-team',
	)
	expect(html).toContain('href="/@selected-team/-/billing"')
})
