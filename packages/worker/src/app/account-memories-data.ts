import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import {
	listMemoriesByUserId,
	listMemoriesByUserIdPage,
} from '#mcp/memory/repo.ts'
import { getMemory } from '#mcp/memory/service.ts'
import {
	type McpMemoryRow,
	type MemoryRecord,
	type MemoryStatus,
} from '#mcp/memory/types.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountMemoryListItem = {
	id: string
	subject: string
	category: string | null
	status: MemoryStatus
	tags: Array<string>
	summary: string
	updatedAt: string
}

export type AccountMemoryDetail = AccountMemoryListItem & {
	details: string
	sourceUris: Array<string>
	dedupeKey: string | null
	createdAt: string
	lastAccessedAt: string | null
	deletedAt: string | null
}

export type AccountMemoriesLoaderData = {
	ok: true
	email: string
	username: string
	memories: Array<AccountMemoryListItem>
	selectedMemory: AccountMemoryDetail | null
	query: string
	includeDeleted: boolean
	/** Team-org legacy list: read-only until cleanup (ADR 0072). */
	legacyReadOnly: boolean
}

/**
 * Portable memories document for the signed-in user. Includes deleted
 * rows only when the page's Include deleted control is on. Omits
 * credentials and other account primitives.
 */
export type AccountMemoriesExport = {
	kind: 'kody-memories'
	version: 1
	exportedAt: string
	includeDeleted: boolean
	memories: Array<AccountMemoryDetail>
}

const accountMemoriesExportPageSize = 200

const accountMemoriesBasePath = '/account/memories'

export function readAccountMemoriesSelectedMemoryId(
	requestUrl: string,
	pathMemoryId?: string,
) {
	if (pathMemoryId?.trim()) return pathMemoryId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountMemoriesBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const memoryId = decodeURIComponent(segment)
				if (memoryId) return memoryId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

export function readAccountMemoriesIncludeDeleted(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	const raw = url.searchParams.get('includeDeleted')?.trim().toLowerCase()
	return raw === '1' || raw === 'true' || raw === 'yes'
}

export function readAccountMemoriesQuery(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	return url.searchParams.get('q')?.trim() ?? ''
}

function toListItem(memory: MemoryRecord): AccountMemoryListItem {
	return {
		id: memory.id,
		subject: memory.subject,
		category: memory.category,
		status: memory.status,
		tags: memory.tags,
		summary: memory.summary,
		updatedAt: memory.updatedAt,
	}
}

function toDetail(memory: MemoryRecord): AccountMemoryDetail {
	return {
		...toListItem(memory),
		details: memory.details,
		sourceUris: memory.sourceUris,
		dedupeKey: memory.dedupeKey,
		createdAt: memory.createdAt,
		lastAccessedAt: memory.lastAccessedAt,
		deletedAt: memory.deletedAt,
	}
}

function toExportItem(row: McpMemoryRow): AccountMemoryDetail {
	return {
		id: row.id,
		subject: row.subject,
		category: row.category,
		status: row.status,
		tags: parseJsonStringArray(row.tags_json),
		summary: row.summary,
		updatedAt: row.updated_at,
		details: row.details,
		sourceUris: parseJsonStringArray(row.source_uris_json),
		dedupeKey: row.dedupe_key,
		createdAt: row.created_at,
		lastAccessedAt: row.last_accessed_at,
		deletedAt: row.deleted_at,
	}
}

function memoryStatusesForExport(includeDeleted: boolean): Array<MemoryStatus> {
	return includeDeleted
		? ['active', 'archived', 'deleted']
		: ['active', 'archived']
}

export function memoryMatchesQuery(
	memory: AccountMemoryListItem,
	query: string,
) {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return true
	const haystack = [
		memory.subject,
		memory.category,
		memory.status,
		memory.summary,
		...memory.tags,
	]
		.filter((value): value is string => typeof value === 'string')
		.join(' ')
		.toLocaleLowerCase()
	return tokens.every((token) => haystack.includes(token))
}

export async function loadAccountMemoriesData(input: {
	env: Env
	user: AuthenticatedUser
	query: string
	includeDeleted: boolean
	selectedMemoryId: string | null
}): Promise<AccountMemoriesLoaderData> {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const legacyReadOnly = !(await isPersonalOrg(input.env.APP_DB, userId))
	const { query, includeDeleted, selectedMemoryId } = input
	const statuses = memoryStatusesForExport(includeDeleted)

	const rows = await listMemoriesByUserId(input.env.APP_DB, userId, {
		includeDeleted,
		statuses,
		limit: 100,
	})
	const memories = rows
		.map((row) =>
			toListItem({
				id: row.id,
				category: row.category,
				status: row.status,
				subject: row.subject,
				summary: row.summary,
				details: row.details,
				tags: parseJsonStringArray(row.tags_json),
				sourceUris: parseJsonStringArray(row.source_uris_json),
				dedupeKey: row.dedupe_key,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				lastAccessedAt: row.last_accessed_at,
				deletedAt: row.deleted_at,
			}),
		)
		.filter((memory) => memoryMatchesQuery(memory, query))

	const selectedMemory = selectedMemoryId
		? await resolveSelectedMemory({
				env: input.env,
				userId,
				memoryId: selectedMemoryId,
				includeDeleted,
			})
		: null

	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		memories,
		selectedMemory,
		query,
		includeDeleted,
		legacyReadOnly,
	}
}

async function resolveSelectedMemory(input: {
	env: Env
	userId: OwnerId
	memoryId: string
	includeDeleted: boolean
}): Promise<AccountMemoryDetail | null> {
	const memory = await getMemory({
		env: input.env,
		userId: input.userId,
		memoryId: input.memoryId,
		includeDeleted: input.includeDeleted,
	})
	return memory ? toDetail(memory) : null
}

export async function loadAccountMemoriesExport(input: {
	env: Env
	user: AuthenticatedUser
	includeDeleted: boolean
}): Promise<AccountMemoriesExport> {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const statuses = memoryStatusesForExport(input.includeDeleted)
	const memories: Array<AccountMemoryDetail> = []
	let afterId: string | null = null
	while (true) {
		const rows = await listMemoriesByUserIdPage({
			db: input.env.APP_DB,
			userId,
			afterId,
			statuses,
			includeDeleted: input.includeDeleted,
			limit: accountMemoriesExportPageSize,
		})
		for (const row of rows) {
			memories.push(toExportItem(row))
		}
		if (rows.length < accountMemoriesExportPageSize) break
		const lastId = rows.at(-1)?.id
		if (!lastId) break
		afterId = lastId
	}
	return {
		kind: 'kody-memories',
		version: 1,
		exportedAt: new Date().toISOString(),
		includeDeleted: input.includeDeleted,
		memories,
	}
}
