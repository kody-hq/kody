import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
const orgSlug = z.string().min(1)
export const updateOrganizationProfile = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({
			orgSlug,
			displayName: z.string().optional(),
			slug: z.string().optional(),
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
export const deleteOrganization = createServerFn({ method: 'POST' })
	.inputValidator(z.object({ orgSlug, confirmation: z.string() }))
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
	.inputValidator(z.object({ orgSlug }))
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
	.inputValidator(
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
	.inputValidator(
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
	.inputValidator(
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
	.inputValidator((data: FormData) => {
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
