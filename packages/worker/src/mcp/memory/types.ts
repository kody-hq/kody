import { memoryState, type MemoryStatus } from './memory-state.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

export const memoryStatusValues = memoryState.values

export type { MemoryStatus } from './memory-state.ts'

export type MemoryCategory = string | null

export type MemoryRow = {
	id: string
	user_id: OwnerId
	category: MemoryCategory
	status: MemoryStatus
	subject: string
	summary: string
	details: string
	tags_json: string
	source_uris_json: string
	dedupe_key: string | null
	created_at: string
	updated_at: string
	last_accessed_at: string | null
	deleted_at: string | null
}

export type McpMemoryRow = MemoryRow

export type MemoryConversationSuppressionRow = {
	user_id: string
	conversation_id: string
	memory_id: string
	created_at: string
	last_seen_at: string
	expires_at: string
}

export type McpMemoryConversationSuppressionRow =
	MemoryConversationSuppressionRow

export type MemoryMetadata = {
	id: string
	category: MemoryCategory
	status: MemoryStatus
	subject: string
	summary: string
	details: string
	tags: Array<string>
	sourceUris: Array<string>
	dedupeKey: string | null
	createdAt: string
	updatedAt: string
	lastAccessedAt: string | null
	deletedAt: string | null
}

export type MemoryRecord = MemoryMetadata

export type MemorySearchHit = MemoryMetadata & {
	score: number
	lexicalRank?: number
	vectorRank?: number
	/** Cosine similarity to the query embedding; absent offline or on a vector miss. */
	vectorScore?: number
}

export type MemorySearchMatch = MemorySearchHit
