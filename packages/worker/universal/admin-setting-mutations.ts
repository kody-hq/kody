import { z } from 'zod'

export const setGlobalFeatureFlagSchema = z.object({
	key: z.string(),
	enabled: z.boolean(),
	rolloutPercent: z.number().int().min(0).max(100).nullish(),
	note: z.string().nullish(),
	audience: z.string().nullish(),
})
export const clearFeatureFlagOverrideSchema = z.object({
	key: z.string(),
	stableUserId: z.string().nullish(),
	username: z.string().nullish(),
})
export const setFeatureFlagOverrideSchema =
	clearFeatureFlagOverrideSchema.extend({ enabled: z.boolean() })
export const deleteStaleFlagSchema = z.object({ key: z.string() })
export const reservedUsernamesSchema = z.object({
	usernames: z.array(z.string()),
})
export const addAppStarterSchema = z.object({
	package: z.string(),
	rank: z.number().int().min(1).optional(),
	enabled: z.boolean(),
})
export const reorderAppStartersSchema = z.object({
	packageIds: z.array(z.string().min(1)),
})
export const updateAppStarterSchema = z.object({
	packageId: z.string().min(1),
	rank: z.number().int().min(1).optional(),
	enabled: z.boolean().optional(),
	note: z.string().optional(),
})
export const removeAppStarterSchema = z.object({
	packageId: z.string().min(1),
})
export type SetGlobalFeatureFlagInput = z.infer<
	typeof setGlobalFeatureFlagSchema
>
export const clearFeatureFlagOrgOverrideSchema = z.object({
	key: z.string(),
	orgSlug: z.string(),
})
export const setFeatureFlagOrgOverrideSchema =
	clearFeatureFlagOrgOverrideSchema.extend({
		enabled: z.boolean(),
		note: z.string().nullish(),
	})
export type SetFeatureFlagOrgOverrideInput = z.infer<
	typeof setFeatureFlagOrgOverrideSchema
>
export type ClearFeatureFlagOrgOverrideInput = z.infer<
	typeof clearFeatureFlagOrgOverrideSchema
>
export type SetFeatureFlagOverrideInput = z.infer<
	typeof setFeatureFlagOverrideSchema
>
export type ClearFeatureFlagOverrideInput = z.infer<
	typeof clearFeatureFlagOverrideSchema
>
export type AddAppStarterInput = z.infer<typeof addAppStarterSchema>
export type UpdateAppStarterInput = z.infer<typeof updateAppStarterSchema>
export type RemoveAppStarterInput = z.infer<typeof removeAppStarterSchema>
export type ReorderAppStartersInput = z.infer<typeof reorderAppStartersSchema>
