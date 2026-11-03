import { readdirSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

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

export function applyAllMigrations(db: DatabaseSync, migrationsDirectory: URL) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		applyMigrationFile(
			db,
			readFileSync(new URL(fileName, migrationsDirectory), 'utf8'),
		)
	}
}
