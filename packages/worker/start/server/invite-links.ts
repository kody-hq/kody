import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { packageAccessInput } from '#universal/package-access-mutations.ts'
const options = z.object({
	maxUses: z.union([z.string(), z.number()]).nullish(),
	expiresInDays: z.union([z.string(), z.number()]).nullish(),
	allowedEmailDomains: z.union([z.string(), z.array(z.string())]).optional(),
})
const orgScope = z.object({ orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/) })

export const createTeamInviteLink = createServerFn({ method: 'POST' })
	.validator(
		options.extend({
			orgSlug: orgScope.shape.orgSlug,
			teamId: z.string().trim().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { createTeamInviteLink } =
			await import('../../src/app/handlers/org-teams-invite-links.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await createTeamInviteLink({ ...context, ...data }),
				),
		)
	})

export const revokeTeamInviteLink = createServerFn({ method: 'POST' })
	.validator(orgScope.extend({ linkId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { revokeTeamInviteLink } =
			await import('../../src/app/handlers/org-teams-invite-links.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await revokeTeamInviteLink({ ...context, ...data }),
				),
		)
	})

export const loadPackageInviteLinks = createServerFn({ method: 'GET' })
	.validator(packageAccessInput)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		const { readPackageInviteLinks } =
			await import('../../src/app/handlers/package-invite-links.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteRead({}, async (context) =>
			requireOperationResult(
				await readPackageInviteLinks({
					...context,
					...data,
				}),
			),
		)
	})

export const createPackageInviteLink = createServerFn({ method: 'POST' })
	.validator(
		packageAccessInput.extend({
			...options.shape,
			preset: z.enum(['use', 'contribute', 'manage']),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { createPackageInviteLink } =
			await import('../../src/app/handlers/package-invite-links.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await createPackageInviteLink({
					...context,
					...data,
				}),
			),
		)
	})

export const revokePackageInviteLink = createServerFn({ method: 'POST' })
	.validator(packageAccessInput.extend({ linkId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { revokePackageInviteLink } =
			await import('../../src/app/handlers/package-invite-links.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation({}, async (context) =>
			requireOperationResult(
				await revokePackageInviteLink({
					...context,
					...data,
				}),
			),
		)
	})
