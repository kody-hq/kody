import { z } from 'zod'
export const setOrganizationMemberRoleSchema = z.object({
	userId: z.string(),
	role: z.enum(['owner', 'member', 'billing']),
})
export const removeOrganizationMemberSchema = z.object({ userId: z.string() })
export const inviteOrganizationMemberSchema = z.object({
	invitee: z.string().optional(),
	email: z.string().optional(),
	username: z.string().optional(),
	role: z.enum(['owner', 'member', 'billing']).optional(),
})
export const createOrganizationInviteLinkSchema = z.object({
	role: z.enum(['member', 'billing']).optional(),
	allowedEmailDomains: z.union([z.string(), z.array(z.string())]).optional(),
	domains: z.union([z.string(), z.array(z.string())]).optional(),
	allowedDomains: z.union([z.string(), z.array(z.string())]).optional(),
	maxUses: z.union([z.number(), z.string()]).nullish(),
	expiresAt: z.string().optional(),
	expiresInDays: z.union([z.number(), z.string()]).nullish(),
})
export const revokeOrganizationInviteLinkSchema = z.object({
	linkId: z.string(),
})
export const createOrganizationTeamSchema = z.object({
	slug: z.string(),
	name: z.string(),
	description: z.string().optional(),
})
export const addOrganizationTeamMemberSchema = z.object({
	teamId: z.string(),
	userId: z.string(),
})
export const removeOrganizationTeamMemberSchema = z.object({
	teamId: z.string(),
	userId: z.string(),
})
export const revokeOrganizationGrantSchema = z.object({ grantId: z.string() })

export const revokeOrganizationMemberInviteSchema = z.object({
	inviteId: z.string().trim().min(1),
})
