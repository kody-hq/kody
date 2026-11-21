import { z } from 'zod'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/** Stable ids read back from D1 (`orgs.id`, `users.stable_user_id`). */
export const ownerIdColumn = z
	.string()
	.min(1)
	.transform((value) => value as OwnerId)

export const dbIdColumn = z.number().int()

/** Any non-empty timestamp text D1 stored (ISO or SQLite `datetime`). */
export const timestampColumn = z.string().min(1)

export const nullableTimestampColumn = timestampColumn.nullable()

/** `D1Result.meta` for writes; `changes` defaults to 0 like `?? 0` did. */
export const d1ChangesMetaSchema = z
	.object({ changes: z.number().int().nonnegative().optional() })
	.transform((meta) => ({ changes: meta.changes ?? 0 }))

export function formatIssues(error: z.ZodError) {
	return error.issues
		.map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`)
		.join('; ')
}
