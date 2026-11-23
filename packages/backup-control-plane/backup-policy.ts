import type { BackupEnvironment, LogRecord } from './backup-types.ts'

const CLOUDFLARE_ID_PATTERN =
	/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export type SourceDatabase = {
	id: string
	name: string
}

export class BackupError extends Error {
	readonly code: string
	readonly retryable: boolean

	constructor(code: string, message: string, retryable = false) {
		super(message)
		this.name = 'BackupError'
		this.code = code
		this.retryable = retryable
	}
}

export function workflowBackupErrorMessage(
	error: Pick<BackupError, 'code' | 'message'>,
): string {
	return `[${error.code}] ${error.message}`
}

export function isBackupEnabled(env: BackupEnvironment): boolean {
	return (
		env.ENABLE_PRODUCTION_D1_BACKUPS === 'true' &&
		env.BACKUP_BENCHMARK_APPROVED === 'true'
	)
}

function parseAllowlist(value: string, field: string): Set<string> {
	const entries = value
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
	if (entries.length === 0) {
		throw new BackupError('empty-allowlist', `${field} cannot be empty`)
	}
	return new Set(entries)
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): boolean {
	const actual = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	)
}

function parseSourceDatabasesJson(
	value: string,
	label = 'SOURCE_DATABASES',
): Array<SourceDatabase> {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw new BackupError(
			'invalid-source-databases',
			`${label} must be a JSON array of { id, name } objects`,
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		throw new BackupError(
			'invalid-source-databases',
			`${label} must be a JSON array of { id, name } objects`,
		)
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new BackupError(
			'invalid-source-databases',
			`${label} must be a JSON array of { id, name } objects`,
		)
	}
	const sources: Array<SourceDatabase> = []
	const ids = new Set<string>()
	const names = new Set<string>()
	for (const entry of parsed) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new BackupError(
				'invalid-source-databases',
				`${label} entries must be { id, name } objects`,
			)
		}
		const record = entry as Record<string, unknown>
		if (!hasExactKeys(record, ['id', 'name'])) {
			throw new BackupError(
				'invalid-source-databases',
				`${label} entries must be { id, name } objects`,
			)
		}
		if (
			typeof record.id !== 'string' ||
			!CLOUDFLARE_ID_PATTERN.test(record.id) ||
			typeof record.name !== 'string' ||
			record.name.trim().length === 0
		) {
			throw new BackupError(
				'invalid-source-databases',
				`${label} entries need a UUID id and a non-empty name`,
			)
		}
		const id = record.id
		const name = record.name
		if (ids.has(id.toLowerCase()) || names.has(name)) {
			throw new BackupError(
				'duplicate-source-database',
				`${label} contains a duplicate id or name`,
			)
		}
		ids.add(id.toLowerCase())
		names.add(name)
		sources.push({ id, name })
	}
	return sources
}

/**
 * Paced D1 sources (`D1_PACED_SOURCES`, same ids as the worker's
 * `DR_D1_PACED_SOURCES`). Their sealed paced nights are the full seal's D1
 * source of truth (read-only R2 keys); the list must include the primary.
 */
export function pacedSourceDatabases(
	env: BackupEnvironment,
): Array<SourceDatabase> {
	assertConfiguredIdentity(env)
	if (env.D1_PACED_SOURCES === undefined) {
		throw new BackupError(
			'invalid-paced-sources',
			'D1_PACED_SOURCES must list the paced D1 sources',
		)
	}
	const sources = parseSourceDatabasesJson(
		env.D1_PACED_SOURCES,
		'D1_PACED_SOURCES',
	)
	if (
		!sources.some(
			(source) =>
				source.id.toLowerCase() === env.SOURCE_DATABASE_ID.toLowerCase(),
		)
	) {
		throw new BackupError(
			'invalid-paced-sources',
			'D1_PACED_SOURCES must include SOURCE_DATABASE_ID',
		)
	}
	return sources
}

export function primarySourceDatabase(env: BackupEnvironment): SourceDatabase {
	return { id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME }
}

export function configuredSourceDatabases(
	env: BackupEnvironment,
): Array<SourceDatabase> {
	assertConfiguredIdentity(env)
	if (env.SOURCE_DATABASES === undefined) {
		return [primarySourceDatabase(env)]
	}
	return parseSourceDatabasesJson(env.SOURCE_DATABASES)
}

export function absentConfiguredSourceNote(source: SourceDatabase): string {
	if (source.name === 'kody-jobs') {
		return 'JOBS_DB: not present in this backup day'
	}
	return `${source.name}: not present in this backup day`
}

export function restoreImportOrder(
	sources: Array<SourceDatabase>,
	primary: SourceDatabase,
): Array<SourceDatabase> {
	const others = sources.filter(
		(source) => source.id.toLowerCase() !== primary.id.toLowerCase(),
	)
	const primarySource = sources.find(
		(source) => source.id.toLowerCase() === primary.id.toLowerCase(),
	)
	if (primarySource === undefined) {
		throw new BackupError(
			'restore-d1-source-not-configured',
			'sealed D1 sources do not include the primary database',
		)
	}
	return [...others, primarySource]
}

export function bindSourceDatabase(
	env: BackupEnvironment,
	source: SourceDatabase,
): BackupEnvironment {
	return {
		...env,
		SOURCE_DATABASE_ID: source.id,
		SOURCE_DATABASE_NAME: source.name,
	}
}

export function resolveSourceDatabase(
	env: BackupEnvironment,
	selector: string | null | undefined,
): SourceDatabase {
	const sources = configuredSourceDatabases(env)
	if (selector === null || selector === undefined || selector.trim() === '') {
		return primarySourceDatabase(env)
	}
	const requested = selector.trim()
	const match = sources.find(
		(source) =>
			source.name === requested ||
			source.id.toLowerCase() === requested.toLowerCase(),
	)
	if (!match) {
		throw new BackupError(
			'unknown-source-database',
			`source database ${requested} is not configured`,
		)
	}
	return match
}

export function assertConfiguredIdentity(env: BackupEnvironment): void {
	if (
		!CLOUDFLARE_ID_PATTERN.test(env.SOURCE_ACCOUNT_ID) ||
		!CLOUDFLARE_ID_PATTERN.test(env.SOURCE_DATABASE_ID)
	) {
		throw new BackupError(
			'invalid-source-id',
			'source account and database IDs must be UUIDs',
		)
	}
	if (!env.SOURCE_DATABASE_NAME) {
		throw new BackupError(
			'missing-source-name',
			'source database name is required',
		)
	}
	const allowedAccounts = parseAllowlist(
		env.ALLOWED_SOURCE_ACCOUNT_IDS,
		'ALLOWED_SOURCE_ACCOUNT_IDS',
	)
	const allowedDatabases = parseAllowlist(
		env.ALLOWED_SOURCE_DATABASE_IDS,
		'ALLOWED_SOURCE_DATABASE_IDS',
	)
	if (!allowedAccounts.has(env.SOURCE_ACCOUNT_ID.toLowerCase())) {
		throw new BackupError(
			'source-not-allowlisted',
			'configured source identity is not allowlisted',
		)
	}
	const sources =
		env.SOURCE_DATABASES === undefined
			? [primarySourceDatabase(env)]
			: parseSourceDatabasesJson(env.SOURCE_DATABASES)
	const primaryListed = sources.some(
		(source) =>
			source.id.toLowerCase() === env.SOURCE_DATABASE_ID.toLowerCase() &&
			source.name === env.SOURCE_DATABASE_NAME,
	)
	if (!primaryListed) {
		throw new BackupError(
			'source-not-allowlisted',
			'SOURCE_DATABASE_ID/NAME must appear in SOURCE_DATABASES',
		)
	}
	for (const source of sources) {
		if (!allowedDatabases.has(source.id.toLowerCase())) {
			throw new BackupError(
				'source-not-allowlisted',
				'configured source identity is not allowlisted',
			)
		}
	}
}

export function assertRemoteDatabaseIdentity(
	env: BackupEnvironment,
	database: { uuid: string; name: string },
): void {
	assertConfiguredIdentity(env)
	if (
		database.uuid.toLowerCase() !== env.SOURCE_DATABASE_ID.toLowerCase() ||
		database.name !== env.SOURCE_DATABASE_NAME
	) {
		throw new BackupError(
			'source-identity-mismatch',
			'Cloudflare D1 identity did not match the configured UUID and name',
		)
	}
}

export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10)
}

export function safeLog(
	record: LogRecord,
	logger: Pick<Console, 'log' | 'error'> = console,
): void {
	const output = JSON.stringify(record)
	if (record.status === 'failure') logger.error(output)
	else logger.log(output)
}

/**
 * Prefer `BackupError.code`. Across Workflows step RPC the engine often
 * reconstitutes a terminal failure as a plain `Error` whose message is
 * `NonRetryableError: [code] …` (see `engineTreatsAsTerminal`); keep parsing
 * that form for status pages and callers that see the RPC-wrapped message.
 */
export function errorCode(error: unknown): string {
	if (error instanceof BackupError) return error.code
	if (error instanceof Error) {
		const match =
			/^(?:NonRetryableError:\s*)?\[(?<code>[a-z0-9]+(?:-[a-z0-9]+)*)\] /u.exec(
				error.message,
			)
		if (match?.groups?.code) return match.groups.code
	}
	return 'unexpected-error'
}
