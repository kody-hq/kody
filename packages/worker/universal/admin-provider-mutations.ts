import { z } from 'zod'

export const providerMarkSaveSchema = z.object({
	slug: z.string(),
	label: z.string().optional(),
	aliases: z.array(z.string()).optional(),
	logoBase64: z.string().nullable().optional(),
})
export const adminProviderDeleteSchema = z.object({ slug: z.string() })
export const platformIntegrationSaveSchema = z.object({
	slug: z.string(),
	newSlug: z.string().nullable().optional(),
	clientId: z.string(),
	tokenUrl: z.string(),
	authorizeUrl: z.string(),
	flow: z.enum(['pkce', 'confidential']),
	provider: z.string().nullable().optional(),
	label: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	clientSecret: z.string().nullable().optional(),
	apiBaseUrl: z.string().nullable().optional(),
	scopeSeparator: z.string().nullable().optional(),
	usePkce: z.boolean().nullable().optional(),
	enabled: z.boolean().optional(),
	visibility: z.enum(['draft', 'published']).optional(),
	tokenExchangeStyle: z
		.enum(['form', 'basic-json', 'basic-form'])
		.nullable()
		.optional(),
	extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
	allowedScopes: z.array(z.string()).optional(),
	defaultScopes: z.array(z.string()).optional(),
	requiredHosts: z.array(z.string()).optional(),
	logoBase64: z.string().nullable().optional(),
})
export type ProviderMarkSaveInput = z.infer<typeof providerMarkSaveSchema>
export type PlatformIntegrationSaveInput = z.infer<
	typeof platformIntegrationSaveSchema
>
