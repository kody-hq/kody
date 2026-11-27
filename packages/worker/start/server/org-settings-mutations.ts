import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
	sessionInsightsScopes,
	sessionOutcomes,
	sessionStuckKinds,
} from '#universal/session-analytics.ts'
const orgSlug = z.string().min(1)
export const updateOrganizationProfile = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			displayName: z.string().optional(),
			slug: z.string().optional(),
			profileVisibility: z.enum(['public', 'private']).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { updateOrganizationProfile } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await updateOrganizationProfile({ ...context, ...data }),
				),
		)
	})
export const updateOrganizationMemberCreation = createServerFn({
	method: 'POST',
})
	.validator(
		z.object({
			orgSlug,
			packages: z.boolean().optional(),
			credentials: z.boolean().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { updateOrganizationMemberCreation } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await updateOrganizationMemberCreation({ ...context, ...data }),
				),
		)
	})
export const updateOrganizationUsageWarnings = createServerFn({
	method: 'POST',
})
	.validator(z.object({ orgSlug, enabled: z.boolean() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { updateOrganizationUsageWarnings } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await updateOrganizationUsageWarnings({ ...context, ...data }),
				),
		)
	})
export const updateOrganizationSessionAnalytics = createServerFn({
	method: 'POST',
})
	.validator(z.object({ orgSlug, enabled: z.boolean() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { updateOrganizationSessionAnalytics } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await updateOrganizationSessionAnalytics({ ...context, ...data }),
				),
		)
	})
export const deleteOrganization = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug, confirmation: z.string() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteOrganization } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await deleteOrganization({ ...context, ...data }),
				),
		)
	})
export const removeOrganizationPhoto = createServerFn({ method: 'POST' })
	.validator(z.object({ orgSlug }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { removeOrganizationPhoto } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await removeOrganizationPhoto({ ...context, ...data }),
				),
		)
	})
export const addOrganizationDomain = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			hostname: z.string(),
			bindingKind: z.enum(['app', 'org']),
			packageId: z.string().optional(),
			sslMethod: z.enum(['txt', 'http']).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { addOrganizationDomain } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await addOrganizationDomain({ ...context, ...data }),
				),
		)
	})
export const syncOrganizationDomain = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			hostname: z.string().optional(),
			id: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { syncOrganizationDomain } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await syncOrganizationDomain({ ...context, ...data }),
				),
		)
	})
export const deleteOrganizationDomain = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			hostname: z.string().optional(),
			id: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteOrganizationDomain } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await deleteOrganizationDomain({ ...context, ...data }),
				),
		)
	})
export const saveOrganizationAvatar = createServerFn({ method: 'POST' })
	.validator((data: FormData) => {
		if (!(data instanceof FormData)) throw new Error('Invalid avatar form')
		orgSlug.parse(data.get('orgSlug'))
		return data
	})
	.handler(async ({ data }) => {
		const orgSlug = String(data.get('orgSlug'))
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { saveOrganizationPhoto } =
			await import('../../src/app/handlers/org-settings.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		const avatar = data.get('avatar')
		return withWebsiteMutation({ scope: { orgSlug } }, async (context) =>
			requireOperationResult(
				await saveOrganizationPhoto({
					...context,
					orgSlug,
					avatar: avatar instanceof File ? avatar : null,
				}),
			),
		)
	})
export const deleteOrganizationSessionInsights = createServerFn({
	method: 'POST',
})
	.validator(
		z.object({
			orgSlug,
			scope: z.enum(sessionInsightsScopes),
			entry: z
				.object({
					categoryId: z.string(),
					outcome: z.enum(sessionOutcomes),
					stuckKind: z.enum(sessionStuckKinds).nullable(),
					stuckTool: z.string().nullable(),
				})
				.optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteOrganizationSessionInsights } =
			await import('../../src/app/handlers/session-insights.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await deleteOrganizationSessionInsights({ ...context, ...data }),
				),
		)
	})
