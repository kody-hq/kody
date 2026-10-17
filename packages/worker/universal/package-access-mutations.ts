import { z } from 'zod'
import { packageCollaboratorPresets } from './package-collaborators.ts'
export const packageAccessInput = z.object({
	username: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	kodyId: z.string().min(1),
})
export const grantPackageCollaboratorInput = packageAccessInput.extend({
	subjectType: z.enum(['user', 'team']),
	subjectId: z.string().trim().min(1),
	preset: z.enum(packageCollaboratorPresets),
})
export const revokePackageCollaboratorInput = packageAccessInput.extend({
	grantId: z.string().trim().min(1),
})
export const createPackageCollaboratorInviteInput = packageAccessInput.extend({
	invitee: z.string().trim().min(1),
	preset: z.enum(packageCollaboratorPresets),
})
export const revokePackageCollaboratorInviteInput = packageAccessInput.extend({
	inviteId: z.string().trim().min(1),
})
export const packageWebhookInput = packageAccessInput.extend({
	webhookName: z.string().trim().min(1),
	endpointId: z.string().trim().min(1).optional(),
	createInstance: z.boolean().optional(),
	instanceLabel: z.string().trim().min(1).max(64).optional(),
})
