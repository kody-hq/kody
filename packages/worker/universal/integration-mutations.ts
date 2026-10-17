import { z } from 'zod'
export const rotateOauthAppCredentialsSchema = z
	.object({
		appSlug: z.string().min(1),
		clientId: z.string().min(1).optional(),
		clientSecret: z.string().min(1).optional(),
		confirm: z.literal(true),
	})
	.strict()
	.refine((value) => Boolean(value.clientId || value.clientSecret), {
		message: 'Provide a new client id and/or client secret.',
	})

export const disconnectConnectionSchema = z
	.object({
		name: z.string().min(1),
	})
	.strict()

export const deleteOauthAppSchema = z
	.object({
		appSlug: z.string().min(1),
	})
	.strict()

export const setUsageSchema = z
	.object({
		name: z.string().min(1),
		usageMode: z.enum(['any', 'packages']),
		allowedPackageIds: z.array(z.string()).optional(),
	})
	.strict()

export const approvePackageSchema = z
	.object({
		name: z.string().min(1),
		packageId: z.string().min(1),
	})
	.strict()
