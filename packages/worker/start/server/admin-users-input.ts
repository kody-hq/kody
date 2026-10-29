import { z } from 'zod'

export const adminUsersReadInput = z.object({
	query: z.string(),
	role: z.string(),
	verification: z.string(),
	status: z.enum(['live', 'deleted']).default('live'),
	pageSize: z.number().int().positive().max(100),
})
