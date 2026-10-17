import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
const orgInput = z.object({ orgSlug: z.string().min(1) })
const creditSettingsInput = orgInput.extend({
	autoRefill: z.object({
		enabled: z.boolean(),
		thresholdCents: z.number().nullable(),
		amountCents: z.number().nullable(),
		monthlyCapCents: z.number().nullable(),
	}),
	notify: z.object({
		autoRefilled: z.boolean(),
		monthlyCap: z.boolean(),
		lowBalance: z.boolean(),
	}),
})
export const startCheckout = createServerFn({ method: 'POST' })
	.validator(
		orgInput.extend({
			plan: z.literal('pro'),
			interval: z.enum(['month', 'year']),
			promoCode: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { startWebsiteCheckout } =
			await import('../../src/app/handlers/org-billing.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await startWebsiteCheckout({
						...context,
						orgSlug: data.orgSlug,
						body: data,
					}),
				),
		)
	})
export const startCreditTopUp = createServerFn({ method: 'POST' })
	.validator(orgInput.extend({ amountCents: z.number() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { startWebsiteCreditTopUp } =
			await import('../../src/app/handlers/account-credits.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await startWebsiteCreditTopUp({
						...context,
						orgSlug: data.orgSlug,
						body: data,
					}),
				),
		)
	})
export const saveCreditSettings = createServerFn({ method: 'POST' })
	.validator(creditSettingsInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { saveWebsiteCreditSettings } =
			await import('../../src/app/handlers/account-credits.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await saveWebsiteCreditSettings({
						...context,
						orgSlug: data.orgSlug,
						body: data,
					}),
				),
		)
	})
export const sendCancellationFeedback = createServerFn({ method: 'POST' })
	.validator(z.object({ details: z.string().trim().min(1).max(8000) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { submitWebsiteCancellationFeedback } =
			await import('../../src/app/handlers/org-billing.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await submitWebsiteCancellationFeedback({ ...context, body: data }),
			),
		)
	})
export const openBillingPortal = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { openWebsiteBillingPortal } =
			await import('../../src/app/handlers/org-billing.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await openWebsiteBillingPortal({ ...context, ...data }),
				),
		)
	})
