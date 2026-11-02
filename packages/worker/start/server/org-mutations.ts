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
	grantOrganizationReadAccessSchema,
	grantOrganizationCreateAccessSchema,
	grantOrganizationManageAccessSchema,
} from '#universal/org-people-mutations.ts'
export const setOrganizationMemberRole = createServerFn({ method: 'POST' })
	.validator(
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
	.validator(
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
	.validator(
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
	.validator(
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
	.validator(
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
	.validator(
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
	.validator(
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
	.validator(
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
	.validator(
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

export const grantOrganizationReadAccess = createServerFn({ method: 'POST' })
	.validator(
		grantOrganizationReadAccessSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { grantOrganizationReadAccess } =
			await import('../../src/app/handlers/org-grants.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await grantOrganizationReadAccess({ ...context, ...data }),
				),
		)
	})

export const grantOrganizationCreateAccess = createServerFn({ method: 'POST' })
	.validator(
		grantOrganizationCreateAccessSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { grantOrganizationCreateAccess } =
			await import('../../src/app/handlers/org-grants.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await grantOrganizationCreateAccess({ ...context, ...data }),
				),
		)
	})

export const grantOrganizationManageAccess = createServerFn({ method: 'POST' })
	.validator(
		grantOrganizationManageAccessSchema.extend({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { grantOrganizationManageAccess } =
			await import('../../src/app/handlers/org-grants.ts')
		const { requireOperationResult } =
			await import('../../src/app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async (context) =>
				requireOperationResult(
					await grantOrganizationManageAccess({ ...context, ...data }),
				),
		)
	})

export const revokeOrganizationMemberInvite = createServerFn({ method: 'POST' })
	.validator(
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
