import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import type { McpMemoryRow } from './types.ts'

export function buildMemoryEmbedText(input: {
	category: string | null
	subject: string
	summary: string
	details: string
	tags: Array<string>
	dedupeKey?: string | null
}) {
	return [
		input.category ?? '',
		input.subject,
		input.summary,
		input.details,
		input.tags.join(' '),
		input.dedupeKey ?? '',
	]
		.join('\n')
		.trim()
		.slice(0, 8_000)
}

export function buildMemoryEmbedTextFromRow(row: McpMemoryRow) {
	return buildMemoryEmbedText({
		category: row.category,
		subject: row.subject,
		summary: row.summary,
		details: row.details,
		tags: parseJsonStringArray(row.tags_json),
		dedupeKey: row.dedupe_key,
	})
}
