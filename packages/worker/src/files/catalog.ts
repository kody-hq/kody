import { type FileMetadata, type FileRevision } from '#universal/files.ts'
import { allStorageRows } from './storage-pages.ts'

/** The catalog and history share the FileStore's SQLite transaction boundary. */
export class FileCatalog<T extends FileMetadata> {
	private ready = false
	private initializing?: Promise<void>
	private storage: DurableObjectStorage
	constructor(storage: DurableObjectStorage) {
		this.storage = storage
	}
	async initialize() {
		if (this.ready) return
		return (this.initializing ??= this.migrate().catch((error) => {
			this.initializing = undefined
			throw error
		}))
	}
	private async migrate() {
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS file_catalog (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, trashed INTEGER NOT NULL, data TEXT NOT NULL)`,
		)
		this.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS file_catalog_parent_name ON file_catalog(parent_id,trashed,name COLLATE NOCASE,id)`,
		)
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS file_history (file_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(file_id,id))`,
		)
		this.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS file_history_order ON file_history(file_id,created_at,id)`,
		)
		if (!(await this.storage.get('catalog-sql-v1'))) {
			const legacy = await allStorageRows<T>(this.storage, 'file:')
			await this.storage.transaction(async (tx) => {
				for (const file of legacy.values()) this.put(file)
				await tx.put('catalog-sql-v1', true)
				for (const key of legacy.keys()) await tx.delete(key)
			})
		}
		this.ready = true
	}
	put(file: T) {
		const {
			revisions,
			historyCursor: _cursor,
			revisionCount: _count,
			...metadata
		} = file
		this.storage.sql.exec(
			'INSERT INTO file_catalog(id,parent_id,name,trashed,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,trashed=excluded.trashed,data=excluded.data',
			file.id,
			file.parentId ?? null,
			file.name,
			file.trashedAt ? 1 : 0,
			JSON.stringify(metadata),
		)
		for (const revision of revisions)
			this.storage.sql.exec(
				'INSERT OR IGNORE INTO file_history(file_id,id,created_at,bytes,data) VALUES(?,?,?,?,?)',
				file.id,
				revision.id,
				revision.createdAt,
				revision.bytes + (revision.collaborationBytes ?? 0),
				JSON.stringify(revision),
			)
	}
	get(id: string): T | undefined {
		const row = this.storage.sql
			.exec<{ data: string }>('SELECT data FROM file_catalog WHERE id=?', id)
			.toArray()[0]
		if (!row) return undefined
		const metadata = JSON.parse(row.data)
		const page = this.history(id)
		const revisions = page.revisions.toReversed()
		if (
			metadata.revisionId &&
			!revisions.some((r) => r.id === metadata.revisionId)
		) {
			const head = this.revision(id, metadata.revisionId)
			if (head) revisions.push(head)
		}
		return {
			...metadata,
			revisions,
			historyCursor: page.nextCursor,
			revisionCount: this.storage.sql
				.exec<{ count: number }>(
					'SELECT COUNT(*) AS count FROM file_history WHERE file_id=?',
					id,
				)
				.one().count,
		} as T
	}
	history(fileId: string, cursor?: string) {
		let after: { created_at: string; id: string } | undefined
		if (cursor) {
			after = this.storage.sql
				.exec<{ created_at: string; id: string }>(
					'SELECT created_at,id FROM file_history WHERE file_id=? AND id=?',
					fileId,
					cursor,
				)
				.toArray()[0]
			if (!after) throw new Error('Invalid history cursor.')
		}
		const rows = after
			? this.storage.sql
					.exec<{ id: string; data: string }>(
						'SELECT id,data FROM file_history WHERE file_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 51',
						fileId,
						after.created_at,
						after.id,
					)
					.toArray()
			: this.storage.sql
					.exec<{ id: string; data: string }>(
						'SELECT id,data FROM file_history WHERE file_id=? ORDER BY created_at DESC,id DESC LIMIT 51',
						fileId,
					)
					.toArray()
		return {
			revisions: rows
				.slice(0, 50)
				.map((row) => JSON.parse(row.data) as FileRevision),
			nextCursor: rows.length > 50 ? rows[49]!.id : null,
		}
	}
	revision(fileId: string, id: string) {
		const row = this.storage.sql
			.exec<{ data: string }>(
				'SELECT data FROM file_history WHERE file_id=? AND id=?',
				fileId,
				id,
			)
			.toArray()[0]
		return row ? (JSON.parse(row.data) as FileRevision) : undefined
	}
	all() {
		return this.storage.sql
			.exec<{ data: string; head: string | null; count: number }>(
				`SELECT c.data,h.data AS head,(SELECT COUNT(*) FROM file_history WHERE file_id=c.id) AS count FROM file_catalog c LEFT JOIN file_history h ON h.file_id=c.id AND h.id=json_extract(c.data,'$.revisionId') ORDER BY c.id`,
			)
			.toArray()
			.map(
				(row) =>
					({
						...JSON.parse(row.data),
						revisions: row.head ? [JSON.parse(row.head)] : [],
						revisionCount: row.count,
					}) as T,
			)
	}

	allRevisions() {
		return this.storage.sql
			.exec<{ file_id: string; data: string }>(
				'SELECT file_id,data FROM file_history ORDER BY file_id,created_at,id',
			)
			.toArray()
			.map((row) => ({
				fileId: row.file_id,
				revision: JSON.parse(row.data) as FileRevision,
			}))
	}
	usedBytes() {
		return this.storage.sql
			.exec<{ bytes: number }>(
				"SELECT COALESCE(SUM(bytes),0) AS bytes FROM file_history WHERE json_extract(data,'$.storageId') IS NULL",
			)
			.one().bytes
	}
	remove(id: string) {
		this.storage.sql.exec('DELETE FROM file_history WHERE file_id=?', id)
		this.storage.sql.exec('DELETE FROM file_catalog WHERE id=?', id)
	}
	page(parentId: string | null, cursor?: string, includeTrash = false) {
		const after = cursor ? this.get(cursor) : undefined
		if (cursor && !after) throw new Error('Invalid directory cursor.')
		const rows = this.storage.sql
			.exec<{ id: string }>(
				'SELECT id FROM file_catalog WHERE parent_id IS ? AND (? OR trashed=0) AND (name COLLATE NOCASE,id)>(?,?) ORDER BY name COLLATE NOCASE,id LIMIT 101',
				parentId,
				includeTrash ? 1 : 0,
				after?.name ?? '',
				after?.id ?? '',
			)
			.toArray()
		return {
			files: rows.slice(0, 100).map((row) => {
				const file = this.get(row.id)!
				return {
					...file,
					revisions: file.revisions.filter((r) => r.id === file.revisionId),
					historyCursor: undefined,
				}
			}),
			nextCursor: rows.length > 100 ? rows[99]!.id : null,
		}
	}
}
