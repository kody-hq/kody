import { z } from 'zod'
import { roleNames } from './permissions.ts'
export const assignAdminUserRoleSchema = z.object({
	stableUserId: z.string(),
	role: z.enum(roleNames),
})
export const removeAdminUserRoleSchema = z.object({
	stableUserId: z.string(),
	role: z.enum(roleNames),
})
export const setAdminUserPlanSchema = z.object({
	stableUserId: z.string(),
	plan: z.string().nullable(),
})
export const suspendAdminUserSchema = z.object({ stableUserId: z.string() })
export const unsuspendAdminUserSchema = z.object({ stableUserId: z.string() })
export const resumeAdminUserEmailSchema = z.object({ stableUserId: z.string() })
export const verifyAdminUserEmailSchema = z.object({ stableUserId: z.string() })
export const mintAdminUserVerificationUrlSchema = z.object({
	stableUserId: z.string(),
})
export const verifyAdminUserEmailDestinationSchema = z.object({
	stableUserId: z.string(),
	destinationEmail: z.string(),
})
export const createAdminUserSchema = z.object({
	email: z.string(),
	username: z.string().optional(),
})
