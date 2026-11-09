import { z } from 'zod'
export const fileStorageConfigSchema = z.object({
	id: z.string().uuid(),
	endpoint: z.string().url().max(300),
	bucket: z
		.string()
		.min(3)
		.max(63)
		.regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
	region: z.string().min(1).max(64).default('auto'),
	credentialName: z.string().min(1).max(200),
	authorizedBy: z.string().optional(),
	credentialId: z.string().optional(),
})
export type FileStorageConfig = z.infer<typeof fileStorageConfigSchema>
export const fileStorageStatusSchema = z.object({
	active: fileStorageConfigSchema.nullable(),
	providers: z.array(fileStorageConfigSchema),
})
