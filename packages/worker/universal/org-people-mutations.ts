import { z } from 'zod'
/** Role change on Members. Admin is selectable; only an Owner may assign Owner. */
export const setOrganizationMemberRoleSchema = z.object({
	userId: z.string(),
	role: z.enum(['owner', 'admin', 'member', 'billing']),
})
export const removeOrganizationMemberSchema = z.object({ userId: z.string() })
export const inviteOrganizationMemberSchema = z.object({
	invitee: z.string().optional(),
	email: z.string().optional(),
	username: z.string().optional(),
	role: z.enum(['owner', 'admin', 'member', 'billing']).optional(),
})
/** Invite links cannot grant Owner or Admin; addressed invites can. */
export const createOrganizationInviteLinkSchema = z.object({
	role: z.enum(['member', 'billing']).optional(),
	label: z.string().optional(),
	teamIds: z.array(z.string()).optional(),
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
/** Bulk revoke on a team or everyone Access page (max 100). */
export const revokeOrganizationGrantsSchema = z.object({
	grantIds: z.array(z.string().trim().min(1)).min(1).max(100),
})
export const grantOrganizationReadAccessSchema = z.object({
	subject: z.string(),
	permissions: z.array(z.string()).max(20),
})

const orgSubjectAccessItemSchema = z.object({
	resourceType: z.enum(['package', 'app', 'credential']),
	resourceId: z.string().trim().min(1),
	preset: z.enum(['read', 'use', 'contribute', 'manage']),
})
export type OrgSubjectAccessItem = z.infer<typeof orgSubjectAccessItemSchema>
/**
 * `subject` is `user:<id>`, `team:<id>`, or `org` (everyone in the
 * organization). `userId` is the older spelling of `user:<id>`.
 */
export const grantOrganizationSubjectAccessSchema = z.object({
	userId: z.string().trim().min(1).optional(),
	subject: z.string().trim().min(1).max(220).optional(),
	items: z.array(orgSubjectAccessItemSchema).min(1).max(50),
})

export const grantOrganizationCreateAccessSchema =
	grantOrganizationReadAccessSchema

export const grantOrganizationManageAccessSchema =
	grantOrganizationReadAccessSchema

export const revokeOrganizationMemberInviteSchema = z.object({
	inviteId: z.string().trim().min(1),
})
