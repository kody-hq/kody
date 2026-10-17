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
export type SetGlobalFeatureFlagInput = z.infer<
	typeof setGlobalFeatureFlagSchema
>
export type SetFeatureFlagOverrideInput = z.infer<
	typeof setFeatureFlagOverrideSchema
>
export type ClearFeatureFlagOverrideInput = z.infer<
	typeof clearFeatureFlagOverrideSchema
>
