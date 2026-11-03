import type {
	RepoSessionIndexCleanupResult,
	RepoSessionIndexExportResult,
	RepoSessionIndexRpc,
	RepoSessionIndexUpdateInput,
} from '#worker/repo/repo-session-index-do.ts'
import { isRepoSessionDue } from '#worker/repo/repo-session-due.ts'
import type { RepoSessionRow } from '#worker/repo/types.ts'

/**
 * In-memory RepoSessionIndex stub keyed by `idFromName` (stable userId) for
 * node-unit coverage of catalog paths. Workers suites exercise the real
 * Durable Object binding instead.
 */
export function createInMemoryRepoSessionIndexEnv(
	appDb: D1Database = {
		prepare() {
			throw new Error('APP_DB is not configured on this in-memory index env.')
		},
	} as unknown as D1Database,
): {
	REPO_SESSION_INDEX: Env['REPO_SESSION_INDEX']
	APP_DB: D1Database
	indexes: Map<string, Map<string, RepoSessionRow>>
} {
	const indexes = new Map<string, Map<string, RepoSessionRow>>()

	function rowsFor(userId: string): Map<string, RepoSessionRow> {
		const existing = indexes.get(userId)
		if (existing) return existing
		const created = new Map<string, RepoSessionRow>()
		indexes.set(userId, created)
		return created
	}

	function stubFor(userId: string): RepoSessionIndexRpc {
		const rows = rowsFor(userId)
		return {
			async getRecoveryBookmark() {
				return { bookmark: 'memory' }
			},
			async restoreToBookmark() {
				return { undoBookmark: 'memory' }
			},
			async insertSession(input) {
				if (input.ownerId !== userId) {
					throw new Error('RepoSessionIndex ownerId mismatch.')
				}
				if (!rows.has(input.row.id)) rows.set(input.row.id, input.row)
			},
			async getSessionById(input) {
				return rows.get(input.sessionId) ?? null
			},
			async getActiveByConversation(input) {
				return (
					[...rows.values()]
						.filter(
							(row) =>
								row.conversation_id === input.conversationId &&
								row.status === 'active',
						)
						.sort((left, right) =>
							right.updated_at.localeCompare(left.updated_at),
						)[0] ?? null
				)
			},
			async listBySource(input) {
				return [...rows.values()]
					.filter((row) => row.source_id === input.sourceId)
					.sort((left, right) =>
						right.updated_at.localeCompare(left.updated_at),
					)
			},
			async listByUser() {
				return [...rows.values()].sort((left, right) =>
					right.updated_at.localeCompare(left.updated_at),
				)
			},
			async updateSession(input: RepoSessionIndexUpdateInput) {
				const existing = rows.get(input.sessionId)
				if (!existing) return false
				const next: RepoSessionRow = {
					...existing,
					session_branch:
						input.sessionBranch === undefined
							? existing.session_branch
							: (input.sessionBranch ?? existing.session_branch),
					source_branch: input.sourceBranch ?? existing.source_branch,
					base_commit: input.baseCommit ?? existing.base_commit,
					source_root: input.sourceRoot ?? existing.source_root,
					conversation_id:
						input.conversationId === undefined
							? existing.conversation_id
							: input.conversationId,
					status: input.status ?? existing.status,
					expires_at:
						input.expiresAt === undefined
							? existing.expires_at
							: input.expiresAt,
					last_checkpoint_at:
						input.lastCheckpointAt === undefined
							? existing.last_checkpoint_at
							: input.lastCheckpointAt,
					last_checkpoint_commit:
						input.lastCheckpointCommit === undefined
							? existing.last_checkpoint_commit
							: input.lastCheckpointCommit,
					last_check_run_id:
						input.lastCheckRunId === undefined
							? existing.last_check_run_id
							: input.lastCheckRunId,
					last_check_tree_hash:
						input.lastCheckTreeHash === undefined
							? existing.last_check_tree_hash
							: input.lastCheckTreeHash,
					updated_at: new Date().toISOString(),
				}
				rows.set(input.sessionId, next)
				return true
			},
			async deleteSession(input) {
				return rows.delete(input.sessionId)
			},
			async deleteBySource(input) {
				let deleted = 0
				for (const [id, row] of rows) {
					if (row.source_id === input.sourceId) {
						rows.delete(id)
						deleted += 1
					}
				}
				return deleted
			},
			async countActive() {
				return [...rows.values()].filter((row) => row.status === 'active')
					.length
			},
			async countAll() {
				return rows.size
			},
			async hasActiveForSource(input) {
				return [...rows.values()].some(
					(row) => row.source_id === input.sourceId && row.status === 'active',
				)
			},
			async runDueCleanup(input): Promise<RepoSessionIndexCleanupResult> {
				const now = input.now ? new Date(input.now) : new Date()
				const due = [...rows.values()].filter((row) =>
					isRepoSessionDue(row, now),
				)
				for (const row of due) rows.delete(row.id)
				return { checked: due.length, deleted: due.length, errors: 0 }
			},
			async exportSessions(input): Promise<RepoSessionIndexExportResult> {
				const pageSize = input.pageSize ?? 100
				const after = input.startAfter ?? ''
				const sorted = [...rows.values()]
					.filter((row) => row.id > after)
					.sort((left, right) => left.id.localeCompare(right.id))
				const truncated = sorted.length > pageSize
				const selected = truncated ? sorted.slice(0, pageSize) : sorted
				return {
					rows: selected,
					total: rows.size,
					truncated,
					nextStartAfter: truncated ? (selected.at(-1)?.id ?? null) : null,
				}
			},
			async purge() {
				rows.clear()
				return { ok: true as const }
			},
		}
	}

	const namespace = {
		idFromName(name: string) {
			return { name } as unknown as DurableObjectId
		},
		get(id: DurableObjectId) {
			const userId = String((id as unknown as { name: string }).name)
			return stubFor(userId)
		},
	} as unknown as Env['REPO_SESSION_INDEX']

	return {
		REPO_SESSION_INDEX: namespace,
		APP_DB: appDb,
		indexes,
	}
}
