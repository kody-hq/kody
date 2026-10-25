import {
	type BackupEnvironment,
	type BackupPayload,
	type LogRecord,
	type RetentionTier,
	type ScheduledBackupPayload,
} from './backup-types.ts'

const CLOUDFLARE_ID_PATTERN =
	/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export type SourceDatabase = {
	id: string
	name: string
	/**
	 * When false, skip Cloudflare REST D1 export / freshness / seal-full
	 * prerequisites for this database. Omitted or true keeps REST export on.
	 * Paced D1 backup uses `DR_D1_PACED_SOURCES` independently.
	 */
	restExport?: boolean
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

function parseSourceDatabasesJson(value: string): Array<SourceDatabase> {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		throw new BackupError(
			'invalid-source-databases',
			'SOURCE_DATABASES must be a JSON array of { id, name } or { id, name, restExport } objects',
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		throw new BackupError(
			'invalid-source-databases',
			'SOURCE_DATABASES must be a JSON array of { id, name } or { id, name, restExport } objects',
		)
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new BackupError(
			'invalid-source-databases',
			'SOURCE_DATABASES must be a JSON array of { id, name } or { id, name, restExport } objects',
		)
	}
	const sources: Array<SourceDatabase> = []
	const ids = new Set<string>()
	const names = new Set<string>()
	for (const entry of parsed) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new BackupError(
				'invalid-source-databases',
				'SOURCE_DATABASES entries must be { id, name } or { id, name, restExport } objects',
			)
		}
		const record = entry as Record<string, unknown>
		const hasRestExport = Object.hasOwn(record, 'restExport')
		const allowedKeys = hasRestExport
			? (['id', 'name', 'restExport'] as const)
			: (['id', 'name'] as const)
		if (!hasExactKeys(record, allowedKeys)) {
			throw new BackupError(
				'invalid-source-databases',
				'SOURCE_DATABASES entries must be { id, name } or { id, name, restExport } objects',
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
				'SOURCE_DATABASES entries need a UUID id and a non-empty name',
			)
		}
		if (hasRestExport && typeof record.restExport !== 'boolean') {
			throw new BackupError(
				'invalid-source-databases',
				'SOURCE_DATABASES restExport must be a boolean when present',
			)
		}
		const id = record.id
		const name = record.name
		if (ids.has(id.toLowerCase()) || names.has(name)) {
			throw new BackupError(
				'duplicate-source-database',
				'SOURCE_DATABASES contains a duplicate id or name',
			)
		}
		ids.add(id.toLowerCase())
		names.add(name)
		const source: SourceDatabase = { id, name }
		if (hasRestExport) {
			source.restExport = record.restExport as boolean
		}
		sources.push(source)
	}
	return sources
}

/** REST export is on when `restExport` is omitted or true. */
export function sourceRestExportEnabled(source: SourceDatabase): boolean {
	return source.restExport !== false
}

/**
 * Configured sources that still participate in Cloudflare REST D1 export,
 * hourly freshness, and seal-full REST prerequisites.
 */
export function restExportSourceDatabases(
	env: BackupEnvironment,
): Array<SourceDatabase> {
	return configuredSourceDatabases(env).filter(sourceRestExportEnabled)
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

export type DeclaredD1Source = {
	databaseId: string
	databaseName: string
	manifestKey: string
	manifestSha256: string
}

export function declaredSourceDatabases(
	env: BackupEnvironment,
	declared?: Array<DeclaredD1Source>,
): Array<SourceDatabase> {
	if (declared === undefined || declared.length === 0) {
		return [primarySourceDatabase(env)]
	}
	const configured = configuredSourceDatabases(env)
	const sources: Array<SourceDatabase> = []
	for (const entry of declared) {
		const match = configured.find(
			(source) =>
				source.id.toLowerCase() === entry.databaseId.toLowerCase() &&
				source.name === entry.databaseName,
		)
		if (match === undefined) {
			throw new BackupError(
				'restore-d1-source-not-configured',
				`sealed D1 source ${entry.databaseName} (${entry.databaseId}) is not configured`,
			)
		}
		sources.push(match)
	}
	return sources
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

export function sourceDatabaseFromObjectPrefix(
	env: BackupEnvironment,
	objectPrefix: string,
	day: string,
	tier: RetentionTier,
): SourceDatabase {
	const expectedStart = `${tier}/d1/`
	const expectedEnd = `/${day}`
	if (
		!objectPrefix.startsWith(expectedStart) ||
		!objectPrefix.endsWith(expectedEnd)
	) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload objectPrefix did not match the scheduled day',
		)
	}
	const databaseId = objectPrefix.slice(
		expectedStart.length,
		objectPrefix.length - expectedEnd.length,
	)
	if (databaseId.includes('/')) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload objectPrefix is not a configured source database',
		)
	}
	return resolveSourceDatabase(env, databaseId)
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

export function retentionTier(day: string): RetentionTier {
	const date = new Date(`${day}T00:00:00.000Z`)
	if (Number.isNaN(date.valueOf())) {
		throw new BackupError('invalid-day', 'scheduled day is invalid')
	}
	// Sunday UTC is the weekly retention boundary.
	return date.getUTCDay() === 0 ? 'weekly' : 'daily'
}

export function backupPayload(
	env: BackupEnvironment,
	scheduledAt: Date,
	source: SourceDatabase = primarySourceDatabase(env),
): ScheduledBackupPayload {
	const resolved = resolveSourceDatabase(env, source.id)
	if (source.name !== resolved.name) {
		throw new BackupError(
			'source-identity-mismatch',
			'Cloudflare D1 identity did not match the configured UUID and name',
		)
	}
	const day = utcDay(scheduledAt)
	const tier = retentionTier(day)
	const prefix = `${tier}/d1/${resolved.id}/${day}`
	return {
		kind: 'scheduled',
		scheduledAt: scheduledAt.toISOString(),
		day,
		objectPrefix: prefix,
		manifestKey: `${prefix}/manifest.json`,
		retentionTier: tier,
	}
}

export function objectKeyForBookmark(
	objectPrefix: string,
	bookmark: string,
): string {
	if (
		!/^[A-Za-z0-9._:-]{1,256}$/.test(bookmark) ||
		bookmark === '.' ||
		bookmark === '..'
	) {
		throw new BackupError(
			'unsafe-export-bookmark',
			'D1 export bookmark cannot be safely mapped to an object key',
		)
	}
	const encoded = [...new TextEncoder().encode(bookmark)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
	return `${objectPrefix}/backup-${encoded}.sql`
}

export function objectKeyForPayload(
	payload: BackupPayload,
	bookmark: string,
): string {
	return objectKeyForBookmark(payload.objectPrefix, bookmark)
}

export function isBookmarkObjectKey(
	objectPrefix: string,
	objectKey: string,
): boolean {
	if (!objectKey.startsWith(`${objectPrefix}/`)) return false
	const filename = objectKey.slice(objectPrefix.length + 1)
	return /^backup-(?:[0-9a-f]{2}){1,256}\.sql$/.test(filename)
}

export function workflowInstanceId(databaseId: string, day: string): string {
	return `d1-backup-${databaseId}-${day}`
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
 * that form so in-workflow recovery (e.g. export-result-expired) can match.
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
