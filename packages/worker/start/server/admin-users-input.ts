import { z } from 'zod'

export const adminUsersReadInput = z.object({
	query: z.string(),
	role: z.string(),
	verification: z.string(),
	pageSize: z.number().int().positive().max(100),
})
