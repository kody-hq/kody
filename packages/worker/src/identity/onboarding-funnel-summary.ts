/**
 * Admin readout for the onboarding funnel. Kept off the stamp module so
 * usage recording does not import Analytics Engine SQL (and the mailbox
 * graph that query client pulls in).
 */

import {
	emptyOnboardingFunnel,
	foldOnboardingFunnelRows,
	onboardingFunnelCountQuery,
	resolveOnboardingFunnelDataset,
	type OnboardingFunnelEnv,
} from './onboarding-funnel.ts'
import { queryAnalyticsEngineSql } from '#worker/usage/aggregate-rollups.ts'
import type { AdminInsightsOnboardingFunnel } from '#universal/loader-data.ts'

type FunnelCountRow = {
	stage?: string
	users?: number | string
}

export async function loadOnboardingFunnelSummary(
	env: OnboardingFunnelEnv,
): Promise<AdminInsightsOnboardingFunnel> {
	if (env.WRANGLER_IS_LOCAL_DEV === 'true' || !env.ONBOARDING_FUNNEL_EVENTS) {
		return emptyOnboardingFunnel()
	}
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		console.warn('admin-insights-onboarding-funnel-unavailable', {
			reason: 'missing-analytics-engine-credentials',
		})
		return emptyOnboardingFunnel()
	}
	const dataset = resolveOnboardingFunnelDataset(env)
	const baseUrl =
		env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	try {
		const [days7Rows, days28Rows] = await Promise.all([
			queryAnalyticsEngineSql<FunnelCountRow>({
				accountId,
				apiToken,
				baseUrl,
				query: onboardingFunnelCountQuery({ dataset, days: 7 }),
			}),
			queryAnalyticsEngineSql<FunnelCountRow>({
				accountId,
				apiToken,
				baseUrl,
				query: onboardingFunnelCountQuery({ dataset, days: 28 }),
			}),
		])
		return {
			available: true,
			windows: {
				days7: foldOnboardingFunnelRows(7, days7Rows),
				days28: foldOnboardingFunnelRows(28, days28Rows),
			},
		}
	} catch (error) {
		console.warn('admin-insights-onboarding-funnel-unavailable', { error })
		return emptyOnboardingFunnel()
	}
}
