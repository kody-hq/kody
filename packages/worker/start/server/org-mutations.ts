import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
	revokeOrganizationMemberInviteSchema,
	setOrganizationMemberRoleSchema,
	removeOrganizationMemberSchema,
	inviteOrganizationMemberSchema,
	createOrganizationInviteLinkSchema,
	revokeOrganizationInviteLinkSchema,
	createOrganizationTeamSchema,
	addOrganizationTeamMemberSchema,
	removeOrganizationTeamMemberSchema,
	revokeOrganizationGrantSchema,
} from '#universal/org-people-mutations.ts'
export const setOrganizationMemberRole = createServerFn({ method: 'POST' })
	.inputValidator(
		setOrganizationMemberRoleSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setOrganizationMemberRole } =
			await import('../../src/app/handlers/org-members.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await setOrganizationMemberRole({ ...context, ...data }),
				),
		)
	})
export const removeOrganizationMember = createServerFn({ method: 'POST' })
	.inputValidator(
		removeOrganizationMemberSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { removeOrganizationMember } =
			await import('../../src/app/handlers/org-members.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await removeOrganizationMember({ ...context, ...data }),
				),
		)
	})
export const inviteOrganizationMember = createServerFn({ method: 'POST' })
	.inputValidator(
		inviteOrganizationMemberSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { inviteOrganizationMember } =
			await import('../../src/app/handlers/org-members.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await inviteOrganizationMember({ ...context, ...data }),
				),
		)
	})
export const createOrganizationInviteLink = createServerFn({ method: 'POST' })
	.inputValidator(
		createOrganizationInviteLinkSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { createOrganizationInviteLink } =
			await import('../../src/app/handlers/org-members.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await createOrganizationInviteLink({ ...context, ...data }),
				),
		)
	})
export const revokeOrganizationInviteLink = createServerFn({ method: 'POST' })
	.inputValidator(
		revokeOrganizationInviteLinkSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { revokeOrganizationInviteLink } =
			await import('../../src/app/handlers/org-members.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await revokeOrganizationInviteLink({ ...context, ...data }),
				),
		)
	})
export const createOrganizationTeam = createServerFn({ method: 'POST' })
	.inputValidator(
		createOrganizationTeamSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { createOrganizationTeam } =
			await import('../../src/app/handlers/org-teams.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await createOrganizationTeam({ ...context, ...data }),
				),
		)
	})
export const addOrganizationTeamMember = createServerFn({ method: 'POST' })
	.inputValidator(
		addOrganizationTeamMemberSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { addOrganizationTeamMember } =
			await import('../../src/app/handlers/org-teams.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await addOrganizationTeamMember({ ...context, ...data }),
				),
		)
	})
export const removeOrganizationTeamMember = createServerFn({ method: 'POST' })
	.inputValidator(
		removeOrganizationTeamMemberSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { removeOrganizationTeamMember } =
			await import('../../src/app/handlers/org-teams.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await removeOrganizationTeamMember({ ...context, ...data }),
				),
		)
	})
export const revokeOrganizationGrant = createServerFn({ method: 'POST' })
	.inputValidator(
		revokeOrganizationGrantSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { revokeOrganizationGrant } =
			await import('../../src/app/handlers/org-grants.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await revokeOrganizationGrant({ ...context, ...data }),
				),
		)
	})

export const revokeOrganizationMemberInvite = createServerFn({ method: 'POST' })
	.inputValidator(
		revokeOrganizationMemberInviteSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { revokeOrganizationMemberInvite } =
			await import('../../src/app/handlers/org-members.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await revokeOrganizationMemberInvite({ ...context, ...data }),
				),
		)
	})
