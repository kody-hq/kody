import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getRecoveryBookmark, restoreToBookmark } from '#worker/dr/do-pitr.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { replaceRepoSessionDueOwner } from './repo-session-due-owners.ts'
import {
	editedActiveDueBefore,
	nextOwnerDueAt,
	repoSessionCleanupReason,
	unusedActiveDueBefore,
} from './repo-session-due.ts'
import { repoSessionRpc } from './repo-session-rpc.ts'
import { repoSessionRowSchema, type RepoSessionRow } from './types.ts'

const schemaVersionKey = 'schema_version'
const hydratedFromD1Key = 'hydrated_from_d1'
const repoSessionIndexSchemaVersion = 1
const defaultCleanupBatchSize = 100
const defaultExportPageSize = 100
const maxExportPageSize = 500

type StoredRepoSessionRow = Omit<RepoSessionRow, 'user_id'>

export type RepoSessionIndexExportResult = {
	rows: Array<RepoSessionRow>
	total: number
	truncated: boolean
	nextStartAfter: string | null
}

export type RepoSessionIndexCleanupResult = {
	checked: number
	deleted: number
	errors: number
}

export type RepoSessionIndexUpdateInput = {
	ownerId: OwnerId
	sessionId: string
	sessionBranch?: string | null
	sourceBranch?: string
	baseCommit?: string
	sourceRoot?: string
	conversationId?: string | null
	status?: RepoSessionRow['status']
	expiresAt?: string | null
	lastCheckpointAt?: string | null
	lastCheckpointCommit?: string | null
	lastCheckRunId?: string | null
	lastCheckTreeHash?: string | null
}

function assertNonEmptyString(value: string, label: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${label} must be a non-empty string.`)
	}
	return value
}

function attachOwner(
	ownerId: OwnerId,
	row: StoredRepoSessionRow,
): RepoSessionRow {
	const parsed = repoSessionRowSchema.parse({
		...row,
		user_id: ownerId,
	})
	return { ...parsed, user_id: ownerId }
}

function mapStoredRow(
	row: Record<string, SqlStorageValue>,
): StoredRepoSessionRow {
	return {
		id: String(row['id']),
		source_id: String(row['source_id']),
		source_repo_id: String(row['source_repo_id']),
		session_branch: String(row['session_branch']),
		source_branch: String(row['source_branch']),
		base_commit: String(row['base_commit']),
		source_root: String(row['source_root']),
		conversation_id:
			row['conversation_id'] == null ? null : String(row['conversation_id']),
		status: repoSessionRowSchema.shape.status.parse(String(row['status'])),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
		last_checkpoint_at:
			row['last_checkpoint_at'] == null
				? null
				: String(row['last_checkpoint_at']),
		last_checkpoint_commit:
			row['last_checkpoint_commit'] == null
				? null
				: String(row['last_checkpoint_commit']),
		last_check_run_id:
			row['last_check_run_id'] == null
				? null
				: String(row['last_check_run_id']),
		last_check_tree_hash:
			row['last_check_tree_hash'] == null
				? null
				: String(row['last_check_tree_hash']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

class RepoSessionIndexBase extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
		})
	}

	private get sql() {
		return this.ctx.storage.sql
	}

	private initializeSchema(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS repo_session_index_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`)
		const version = this.readMetaNumber(schemaVersionKey)
		if (version >= repoSessionIndexSchemaVersion) return
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS repo_session_index_owner_identity (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				owner_id TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS repo_sessions (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				source_repo_id TEXT NOT NULL,
				session_branch TEXT NOT NULL,
				source_branch TEXT NOT NULL,
				base_commit TEXT NOT NULL,
				source_root TEXT NOT NULL,
				conversation_id TEXT,
				status TEXT NOT NULL,
				expires_at TEXT,
				last_checkpoint_at TEXT,
				last_checkpoint_commit TEXT,
				last_check_run_id TEXT,
				last_check_tree_hash TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_repo_sessions_source
				ON repo_sessions(source_id);
			CREATE INDEX IF NOT EXISTS idx_repo_sessions_conversation
				ON repo_sessions(conversation_id, status);
			CREATE INDEX IF NOT EXISTS idx_repo_sessions_cleanup
				ON repo_sessions(status, last_checkpoint_at, updated_at, expires_at);
			CREATE INDEX IF NOT EXISTS idx_repo_sessions_status
				ON repo_sessions(status);
		`)
		this.writeMeta(schemaVersionKey, String(repoSessionIndexSchemaVersion))
	}

	private readMeta(key: string): string | null {
		const row = this.sql
			.exec<{ value: string }>(
				`SELECT value FROM repo_session_index_meta WHERE key = ? LIMIT 1`,
				key,
			)
			.toArray()[0]
		return row?.value ?? null
	}

	private readMetaNumber(key: string): number {
		return Number(this.readMeta(key) ?? 0)
	}

	private writeMeta(key: string, value: string): void {
		this.sql.exec(
			`INSERT INTO repo_session_index_meta (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		)
	}

	private getOwnerId(): OwnerId | null {
		const row = this.sql
			.exec<{ owner_id: OwnerId }>(
				`SELECT owner_id FROM repo_session_index_owner_identity
				WHERE singleton = 1
				LIMIT 1`,
			)
			.toArray()[0]
		return row?.owner_id ?? null
	}

	private assertOwner(ownerId: OwnerId): OwnerId {
		const id = assertNonEmptyString(ownerId, 'ownerId')
		const existing = this.getOwnerId()
		if (existing == null) {
			this.sql.exec(
				`INSERT INTO repo_session_index_owner_identity (singleton, owner_id)
				VALUES (1, ?)`,
				id,
			)
			return ownerId
		}
		if (existing !== id) {
			throw new Error(
				`RepoSessionIndex ownerId mismatch; this object is bound to a different owner.`,
			)
		}
		return ownerId
	}

	private isHydrated(): boolean {
		return this.readMeta(hydratedFromD1Key) === '1'
	}

	private markHydrated(): void {
		this.writeMeta(hydratedFromD1Key, '1')
	}

	private insertStoredRow(row: StoredRepoSessionRow): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO repo_sessions (
				id, source_id, source_repo_id, session_branch, source_branch,
				base_commit, source_root, conversation_id, status, expires_at,
				last_checkpoint_at, last_checkpoint_commit, last_check_run_id,
				last_check_tree_hash, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.id,
			row.source_id,
			row.source_repo_id,
			row.session_branch,
			row.source_branch,
			row.base_commit,
			row.source_root,
			row.conversation_id,
			row.status,
			row.expires_at,
			row.last_checkpoint_at,
			row.last_checkpoint_commit,
			row.last_check_run_id,
			row.last_check_tree_hash,
			row.created_at,
			row.updated_at,
		)
	}

	private listStoredRows(): Array<StoredRepoSessionRow> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM repo_sessions ORDER BY updated_at DESC, id DESC`,
			)
			.toArray()
			.map(mapStoredRow)
	}

	private countStoredRows(): number {
		const row = this.sql
			.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM repo_sessions`)
			.toArray()[0]
		return Number(row?.count ?? 0)
	}

	private getStoredRow(sessionId: string): StoredRepoSessionRow | null {
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM repo_sessions WHERE id = ? LIMIT 1`,
				sessionId,
			)
			.toArray()[0]
		return row ? mapStoredRow(row) : null
	}

	private listDueStoredRows(
		now: Date,
		limit: number,
	): Array<StoredRepoSessionRow> {
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM repo_sessions
				WHERE (status IN ('published', 'discarded') AND expires_at IS NOT NULL AND expires_at <= ?)
					OR (status = 'active' AND last_checkpoint_at IS NULL AND updated_at <= ?)
					OR (status = 'active' AND last_checkpoint_at IS NOT NULL AND updated_at <= ?)
				ORDER BY updated_at ASC, id ASC
				LIMIT ?`,
				now.toISOString(),
				unusedActiveDueBefore(now),
				editedActiveDueBefore(now),
				limit,
			)
			.toArray()
			.map(mapStoredRow)
	}

	private async scheduleNextDue(ownerId: OwnerId): Promise<void> {
		const dueAt = nextOwnerDueAt(this.listStoredRows())
		try {
			await replaceRepoSessionDueOwner({
				db: this.env.APP_DB,
				userId: ownerId,
				dueAt,
			})
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: 'repo session due-owner hint write failed',
					userId: ownerId,
					error: getErrorMessage(error),
				}),
			)
		}
		if (dueAt == null) {
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			return
		}
		const alarmAt = Math.max(Date.parse(dueAt), Date.now())
		await this.ctx.storage.setAlarm(alarmAt)
	}

	private async ensureReady(ownerId: OwnerId): Promise<OwnerId> {
		const id = this.assertOwner(ownerId)
		if (!this.isHydrated()) this.markHydrated()
		return id
	}

	async alarm(): Promise<void> {
		const ownerId = this.getOwnerId()
		if (ownerId == null) return
		await this.runDueCleanup({
			ownerId,
			now: new Date().toISOString(),
			limit: defaultCleanupBatchSize,
		})
	}

	async getRecoveryBookmark(input: {
		timestampMs: number
	}): Promise<{ bookmark: string }> {
		return await getRecoveryBookmark(this.ctx, input, {
			environment: this.env,
		})
	}

	async restoreToBookmark(input: {
		bookmark: string
	}): Promise<{ undoBookmark: string }> {
		return await restoreToBookmark(this.ctx, input, {
			objectKind: 'repo_session_index',
			environment: this.env,
		})
	}

	async insertSession(input: {
		ownerId: OwnerId
		row: RepoSessionRow
	}): Promise<void> {
		const ownerId = await this.ensureReady(input.ownerId)
		if (input.row.user_id !== ownerId) {
			throw new Error(
				`RepoSessionIndex insert ownerId mismatch; row belongs to a different user.`,
			)
		}
		this.insertStoredRow(input.row)
		await this.scheduleNextDue(ownerId)
	}

	async getSessionById(input: {
		ownerId: OwnerId
		sessionId: string
	}): Promise<RepoSessionRow | null> {
		const ownerId = await this.ensureReady(input.ownerId)
		const row = this.getStoredRow(input.sessionId)
		return row ? attachOwner(ownerId, row) : null
	}

	async getActiveByConversation(input: {
		ownerId: OwnerId
		conversationId: string
	}): Promise<RepoSessionRow | null> {
		const ownerId = await this.ensureReady(input.ownerId)
		const row = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM repo_sessions
				WHERE conversation_id = ? AND status = 'active'
				ORDER BY updated_at DESC, id DESC
				LIMIT 1`,
				input.conversationId,
			)
			.toArray()[0]
		return row ? attachOwner(ownerId, mapStoredRow(row)) : null
	}

	async listBySource(input: {
		ownerId: OwnerId
		sourceId: string
	}): Promise<Array<RepoSessionRow>> {
		const ownerId = await this.ensureReady(input.ownerId)
		return this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM repo_sessions
				WHERE source_id = ?
				ORDER BY updated_at DESC, id DESC`,
				input.sourceId,
			)
			.toArray()
			.map((row) => attachOwner(ownerId, mapStoredRow(row)))
	}

	async listByUser(input: {
		ownerId: OwnerId
	}): Promise<Array<RepoSessionRow>> {
		const ownerId = await this.ensureReady(input.ownerId)
		return this.listStoredRows().map((row) => attachOwner(ownerId, row))
	}

	async updateSession(input: RepoSessionIndexUpdateInput): Promise<boolean> {
		const ownerId = await this.ensureReady(input.ownerId)
		const assignments: Array<string> = []
		const values: Array<SqlStorageValue> = []
		const add = (column: string, value: SqlStorageValue) => {
			assignments.push(`${column} = ?`)
			values.push(value)
		}
		if (input.sessionBranch !== undefined) {
			add('session_branch', input.sessionBranch)
		}
		if (input.sourceBranch !== undefined)
			add('source_branch', input.sourceBranch)
		if (input.baseCommit !== undefined) add('base_commit', input.baseCommit)
		if (input.sourceRoot !== undefined) add('source_root', input.sourceRoot)
		if (input.conversationId !== undefined) {
			add('conversation_id', input.conversationId)
		}
		if (input.status !== undefined) add('status', input.status)
		if (input.expiresAt !== undefined) add('expires_at', input.expiresAt)
		if (input.lastCheckpointAt !== undefined) {
			add('last_checkpoint_at', input.lastCheckpointAt)
		}
		if (input.lastCheckpointCommit !== undefined) {
			add('last_checkpoint_commit', input.lastCheckpointCommit)
		}
		if (input.lastCheckRunId !== undefined) {
			add('last_check_run_id', input.lastCheckRunId)
		}
		if (input.lastCheckTreeHash !== undefined) {
			add('last_check_tree_hash', input.lastCheckTreeHash)
		}
		add('updated_at', new Date().toISOString())
		this.sql.exec(
			`UPDATE repo_sessions SET ${assignments.join(', ')} WHERE id = ?`,
			...values,
			input.sessionId,
		)
		const updated = this.getStoredRow(input.sessionId) != null
		await this.scheduleNextDue(ownerId)
		return updated
	}

	async deleteSession(input: {
		ownerId: OwnerId
		sessionId: string
	}): Promise<boolean> {
		const ownerId = await this.ensureReady(input.ownerId)
		const existed = this.getStoredRow(input.sessionId) != null
		this.sql.exec(`DELETE FROM repo_sessions WHERE id = ?`, input.sessionId)
		await this.scheduleNextDue(ownerId)
		return existed
	}

	async deleteBySource(input: {
		ownerId: OwnerId
		sourceId: string
	}): Promise<number> {
		const ownerId = await this.ensureReady(input.ownerId)
		const before = this.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM repo_sessions WHERE source_id = ?`,
				input.sourceId,
			)
			.toArray()[0]
		this.sql.exec(
			`DELETE FROM repo_sessions WHERE source_id = ?`,
			input.sourceId,
		)
		await this.scheduleNextDue(ownerId)
		return Number(before?.count ?? 0)
	}

	async countActive(input: { ownerId: OwnerId }): Promise<number> {
		await this.ensureReady(input.ownerId)
		const row = this.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM repo_sessions WHERE status = 'active'`,
			)
			.toArray()[0]
		return Number(row?.count ?? 0)
	}

	async hasActiveForSource(input: {
		ownerId: OwnerId
		sourceId: string
	}): Promise<boolean> {
		await this.ensureReady(input.ownerId)
		const row = this.sql
			.exec<{ present: number }>(
				`SELECT 1 AS present FROM repo_sessions
				WHERE source_id = ? AND status = 'active'
				LIMIT 1`,
				input.sourceId,
			)
			.toArray()[0]
		return row?.present === 1
	}

	async runDueCleanup(input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}): Promise<RepoSessionIndexCleanupResult> {
		const ownerId = await this.ensureReady(input.ownerId)
		const now = input.now ? new Date(input.now) : new Date()
		const due = this.listDueStoredRows(
			now,
			input.limit ?? defaultCleanupBatchSize,
		)
		let deleted = 0
		let errors = 0
		for (const row of due) {
			try {
				await repoSessionRpc(this.env, row.id).cleanupSessionBranch({
					sessionId: row.id,
					userId: ownerId,
					reason: repoSessionCleanupReason(row.status),
				})
				deleted += 1
			} catch (error) {
				errors += 1
				console.warn(
					JSON.stringify({
						message: 'repo session index due cleanup failed',
						sessionId: row.id,
						error: getErrorMessage(error),
					}),
				)
			}
		}
		await this.scheduleNextDue(ownerId)
		return {
			checked: due.length,
			deleted,
			errors,
		}
	}

	async exportSessions(input: {
		ownerId: OwnerId
		pageSize?: number
		startAfter?: string | null
	}): Promise<RepoSessionIndexExportResult> {
		const ownerId = await this.ensureReady(input.ownerId)
		const requested =
			typeof input.pageSize === 'number' && Number.isFinite(input.pageSize)
				? Math.trunc(input.pageSize)
				: defaultExportPageSize
		const pageSize = Math.min(Math.max(requested, 1), maxExportPageSize)
		const after = input.startAfter ?? ''
		const rows = this.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM repo_sessions
				WHERE id > ?
				ORDER BY id ASC
				LIMIT ?`,
				after,
				pageSize + 1,
			)
			.toArray()
			.map(mapStoredRow)
		const truncated = rows.length > pageSize
		const selected = truncated ? rows.slice(0, pageSize) : rows
		return {
			rows: selected.map((row) => attachOwner(ownerId, row)),
			total: this.countStoredRows(),
			truncated,
			nextStartAfter: truncated ? (selected.at(-1)?.id ?? null) : null,
		}
	}

	async countAll(input: { ownerId: OwnerId }): Promise<number> {
		await this.ensureReady(input.ownerId)
		return this.countStoredRows()
	}

	async purge(input: { ownerId: OwnerId }): Promise<{ ok: true }> {
		const ownerId = this.assertOwner(input.ownerId)
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			await this.ctx.storage.deleteAll()
			this.initializeSchema()
			this.assertOwner(ownerId)
			this.markHydrated()
		})
		await replaceRepoSessionDueOwner({
			db: this.env.APP_DB,
			userId: ownerId,
			dueAt: null,
		})
		return { ok: true }
	}
}

export const RepoSessionIndex = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RepoSessionIndexBase,
)
export type RepoSessionIndex = InstanceType<typeof RepoSessionIndex>

export type RepoSessionIndexRpc = {
	getRecoveryBookmark: (input: {
		timestampMs: number
	}) => Promise<{ bookmark: string }>
	restoreToBookmark: (input: {
		bookmark: string
	}) => Promise<{ undoBookmark: string }>
	insertSession: (input: {
		ownerId: OwnerId
		row: RepoSessionRow
	}) => Promise<void>
	getSessionById: (input: {
		ownerId: OwnerId
		sessionId: string
	}) => Promise<RepoSessionRow | null>
	getActiveByConversation: (input: {
		ownerId: OwnerId
		conversationId: string
	}) => Promise<RepoSessionRow | null>
	listBySource: (input: {
		ownerId: OwnerId
		sourceId: string
	}) => Promise<Array<RepoSessionRow>>
	listByUser: (input: { ownerId: OwnerId }) => Promise<Array<RepoSessionRow>>
	updateSession: (input: RepoSessionIndexUpdateInput) => Promise<boolean>
	deleteSession: (input: {
		ownerId: OwnerId
		sessionId: string
	}) => Promise<boolean>
	deleteBySource: (input: {
		ownerId: OwnerId
		sourceId: string
	}) => Promise<number>
	countActive: (input: { ownerId: OwnerId }) => Promise<number>
	countAll: (input: { ownerId: OwnerId }) => Promise<number>
	hasActiveForSource: (input: {
		ownerId: OwnerId
		sourceId: string
	}) => Promise<boolean>
	runDueCleanup: (input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) => Promise<RepoSessionIndexCleanupResult>
	exportSessions: (input: {
		ownerId: OwnerId
		pageSize?: number
		startAfter?: string | null
	}) => Promise<RepoSessionIndexExportResult>
	purge: (input: { ownerId: OwnerId }) => Promise<{ ok: true }>
}
