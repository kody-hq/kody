import { z } from 'zod'
import type { CommandHistory } from './model.ts'
const schema = z.record(
	z.string(),
	z.object({
		count: z.number().finite().nonnegative(),
		lastUsed: z.number().finite().nonnegative(),
		pinned: z.boolean().optional(),
	}),
)
export function readCommandHistory(key: string): CommandHistory {
	try {
		return schema.parse(JSON.parse(localStorage.getItem(key) ?? '{}'))
	} catch {
		return {}
	}
}
export function saveCommandHistory(key: string, history: CommandHistory) {
	// Only identifiers and usage counts are stored, never resource labels or content.
	const entries = Object.entries(history)
		.sort(
			(a, b) =>
				Number(Boolean(b[1].pinned)) - Number(Boolean(a[1].pinned)) ||
				b[1].lastUsed - a[1].lastUsed,
		)
		.slice(0, 200)
	try {
		localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)))
	} catch {
		/* The menu still works when browser storage is unavailable. */
	}
}
