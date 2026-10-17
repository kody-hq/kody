import { z } from 'zod'
import { credentialScopes } from '#universal/credential-contracts.ts'

export const credentialPickSchema = z.union([
	z.strictObject({ id: z.string().trim().min(1) }),
	z.strictObject({
		name: z.string().trim().min(1),
		scope: z.enum(credentialScopes).optional(),
	}),
])
