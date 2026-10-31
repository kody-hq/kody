import { z } from 'zod'
import {
	packageCollaboratorPermissions,
	packageCollaboratorPresets,
} from './package-collaborators.ts'

/** Exactly one of a preset or an advanced permission list, as the API takes. */
const presetOrPermissions = {
	preset: z.enum(packageCollaboratorPresets).nullable().optional(),
	permissions: z.array(z.enum(packageCollaboratorPermissions)).optional(),
}

function hasPresetXorPermissions(input: {
	preset?: string | null
	permissions?: ReadonlyArray<string>
}) {
	return Boolean(input.preset) !== Boolean(input.permissions?.length)
}

const presetOrPermissionsMessage = 'Choose a preset or at least one permission.'
export const packageAccessInput = z.object({
	username: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	kodyId: z.string().min(1),
})
export const grantPackageCollaboratorInput = packageAccessInput
	.extend({
		subjectType: z.enum(['user', 'team', 'org', 'profile']),
		subjectId: z.string().trim().min(1),
		...presetOrPermissions,
		allowUnmappableCredentialChanges: z.boolean().optional(),
	})
	.refine(hasPresetXorPermissions, presetOrPermissionsMessage)
export const revokePackageCollaboratorInput = packageAccessInput.extend({
	grantId: z.string().trim().min(1),
})
export const createPackageCollaboratorInviteInput = packageAccessInput
	.extend({
		invitee: z.string().trim().min(1),
		...presetOrPermissions,
	})
	.refine(hasPresetXorPermissions, presetOrPermissionsMessage)
export const revokePackageCollaboratorInviteInput = packageAccessInput.extend({
	inviteId: z.string().trim().min(1),
})
export const packageWebhookInput = packageAccessInput.extend({
	webhookName: z.string().trim().min(1),
	endpointId: z.string().trim().min(1).optional(),
	createInstance: z.boolean().optional(),
	instanceLabel: z.string().trim().min(1).max(64).optional(),
})
export const packageAppConnectedPeopleInput = packageAccessInput.extend({
	page: z.number().int().min(1).max(100_000).optional(),
})
export const revokePackageAppConnectedPersonInput = packageAccessInput.extend({
	grantId: z.string().trim().min(1),
})
