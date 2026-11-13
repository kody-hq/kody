import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

function isDuplicateColumnError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return message.includes('duplicate column name')
}

function applyStatementsSkippingDuplicateColumns(
	db: DatabaseSync,
	sql: string,
) {
	const withoutComments = sql
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('--'))
		.join('\n')
	const statements = withoutComments
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean)
	for (const statement of statements) {
		try {
			db.exec(`${statement};`)
		} catch (error) {
			if (isDuplicateColumnError(error)) continue
			throw error
		}
	}
}

function applyMigrationFile(db: DatabaseSync, sql: string) {
	try {
		db.exec(sql)
	} catch (error) {
		if (!isDuplicateColumnError(error)) throw error
		applyStatementsSkippingDuplicateColumns(db, sql)
	}
}

function replayMigrations(
	db: DatabaseSync,
	migrationsDirectory: URL,
	before: string | undefined,
) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.filter((file) => !before || file < before)
		.sort()) {
		applyMigrationFile(
			db,
			readFileSync(new URL(fileName, migrationsDirectory), 'utf8'),
		)
	}
}

function isEmptyInMemoryDatabase(db: DatabaseSync) {
	if (db.location() !== null) return false
	return db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get() === undefined
}

// Replaying every migration costs ~500ms per database, and some test files
// create hundreds. Each distinct migration set is replayed once per test file
// into a scratch database; later calls copy its serialized image instead.
const migratedImages = new Map<string, Uint8Array>()

/** `before` stops at the first file whose name sorts at or after it. */
export function applyAllMigrations(
	db: DatabaseSync,
	migrationsDirectory: URL,
	options: { before?: string } = {},
) {
	if (!isEmptyInMemoryDatabase(db)) {
		replayMigrations(db, migrationsDirectory, options.before)
		return
	}
	const key = `${migrationsDirectory.href}\0${options.before ?? ''}`
	let image = migratedImages.get(key)
	if (!image) {
		const scratch = new DatabaseSync(':memory:')
		try {
			replayMigrations(scratch, migrationsDirectory, options.before)
			image = scratch.serialize()
		} finally {
			scratch.close()
		}
		migratedImages.set(key, image)
	}
	db.deserialize(image)
}
