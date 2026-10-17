import { z } from 'zod'

export const adminCodemodRunInputSchema = z.object({
	codemodId: z.string().trim().min(1),
	mode: z.enum(['scan', 'dry-run', 'apply', 'revert']),
	scope: z.union([
		z.literal('fleet'),
		z.object({ userId: z.string().trim().min(1) }),
	]),
	filters: z
		.object({
			userIds: z.array(z.string().trim().min(1)).min(1).optional(),
			packageIds: z.array(z.string().trim().min(1)).min(1).optional(),
			scope: z.literal('credential-need-enforcement').optional(),
		})
		.optional(),
	runId: z.string().trim().min(1).optional(),
	cursor: z.string().nullable().optional(),
	limit: z.number().int().positive().optional(),
	revertOfRunId: z.string().trim().min(1).optional(),
})
export type AdminCodemodRunInput = z.infer<typeof adminCodemodRunInputSchema>
