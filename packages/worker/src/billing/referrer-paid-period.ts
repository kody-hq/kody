import { unixSecondsToIso } from '#universal/referral-program.ts'
import { selectKodyPlanRetainingSubscriptions } from './billing-config.ts'
import {
	listSubscriptions,
	readStripeSubscriptionPeriodEndUnix,
} from './stripe-client.ts'

export async function latestReferrerPaidPeriodEnd(input: {
	env: Env
	referrerOrgId: string
}): Promise<string | null> {
	const row = await input.env.APP_DB.prepare(
		`SELECT stripe_customer_id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(input.referrerOrgId)
		.first<{ stripe_customer_id: string | null }>()
	const customerId = row?.stripe_customer_id?.trim()
	if (!customerId) return null
	const subscriptions = selectKodyPlanRetainingSubscriptions(
		input.env,
		await listSubscriptions(input.env, customerId),
	)
	let latest: string | null = null
	for (const subscription of subscriptions) {
		const iso = unixSecondsToIso(
			readStripeSubscriptionPeriodEndUnix(subscription),
		)
		if (!iso) continue
		if (!latest || Date.parse(iso) > Date.parse(latest)) latest = iso
	}
	return latest
}
