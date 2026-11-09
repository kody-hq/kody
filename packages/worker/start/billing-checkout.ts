export type BillingInterval = 'month' | 'year'
import { isRedirect } from '@tanstack/react-router'
import { mutationOptions } from '@tanstack/react-query'
import {
	addReferrer,
	startCheckout,
	openBillingPortal,
} from '#start/server/billing-mutations'
export async function requestProCheckout(input: {
	orgSlug: string
	interval?: 'month' | 'year'
	promoCode?: string
}) {
	try {
		const result = await startCheckout({
			data: {
				orgSlug: input.orgSlug,
				plan: 'pro',
				interval: input.interval ?? 'month',
				...(input.promoCode?.trim()
					? { promoCode: input.promoCode.trim() }
					: {}),
			},
		})
		return { ok: true as const, url: result.url, mode: result.mode ?? null }
	} catch (error) {
		if (isRedirect(error)) throw error
		return {
			ok: false as const,
			error:
				error instanceof Error
					? error.message
					: 'Unable to start checkout. Try again shortly.',
		}
	}
}

export const billingPortalMutationOptions = mutationOptions({
	retry: false,
	gcTime: 0,
	mutationFn: (orgSlug: string) => openBillingPortal({ data: { orgSlug } }),
})

export const billingCheckoutMutationOptions = mutationOptions({
	retry: false,
	gcTime: 0,
	mutationFn: (input: {
		orgSlug: string
		plan: 'pro'
		interval: BillingInterval
		promoCode: string
	}) => requestProCheckout(input),
})

export async function requestAddReferrer(input: {
	orgSlug: string
	referrer: string
}) {
	try {
		const result = await addReferrer({
			data: { orgSlug: input.orgSlug, referrer: input.referrer.trim() },
		})
		return {
			ok: true as const,
			referrerUsername: result.referrerUsername,
		}
	} catch (error) {
		if (isRedirect(error)) throw error
		return {
			ok: false as const,
			error:
				error instanceof Error
					? error.message
					: 'Unable to save the referrer. Try again shortly.',
		}
	}
}
