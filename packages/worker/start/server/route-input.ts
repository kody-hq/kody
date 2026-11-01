import { notFound } from '@tanstack/react-router'
import { type z } from 'zod'

/**
 * Optional `@{$username}` (and similar) route params reach server fns as empty
 * strings. Treat invalid route-shaped input as not-found, not a Zod client error.
 */
export function parseRouteInput<Schema extends z.ZodType>(
	schema: Schema,
	data: unknown,
): z.infer<Schema> {
	const parsed = schema.safeParse(data)
	if (!parsed.success) throw notFound()
	return parsed.data
}
