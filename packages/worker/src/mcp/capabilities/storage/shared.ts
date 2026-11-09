import { z } from 'zod'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const storageIdSchema = z.object({
	storage_id: z.string().min(1).describe('Durable storage id to inspect.'),
})

export const storageExportOutputSchema = z.object({
	storage_id: z.string(),
	export: z.object({
		entries: z.array(
			z.object({
				key: z.string(),
				value: z.unknown(),
			}),
		),
		estimatedBytes: z.number(),
		truncated: z.boolean(),
		nextStartAfter: z.string().nullable(),
		pageSize: z.number(),
	}),
})

export function requireStorageUser(ctx: CapabilityContext) {
	return requireMcpUser(ctx.callerContext)
}
