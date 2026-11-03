import type { BackupManifest } from '@kody-internal/shared/backup-manifest.ts'

import { canonicalJson, sha256 } from './canonical-json.ts'
import {
	resolveTrustedRestoreBaseline,
	verifyTrustedBackupManifest,
} from './restore-trust.ts'

export { type BackupManifest } from '@kody-internal/shared/backup-manifest.ts'

export const maximumD1BackupSizeBytes = 5 * 1024 * 1024 * 1024
const sha256Pattern = /^[a-f0-9]{64}$/
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const cloudflareAccountIdPattern = /^[0-9a-f]{32}$/
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

export type RestoreBaseline = {
	schemaVersion: 1
	sourceDatabaseId: string
	migrationNames: Array<string>
	schemaSha256: string
	sequenceTables: Array<string>
	isolationChecks: Array<{
		table: string
		userColumn: string
		primaryKeyColumn: string
		users: [
			{ userId: string; rowCount: number; primaryKeySha256: string },
			{ userId: string; rowCount: number; primaryKeySha256: string },
		]
	}>
}

export type RestoreTrustRegistry = {
	schemaVersion: 1
	productionSources: Array<{
		accountId: string
		databaseId: string
		databaseName: string
	}>
	drillTargets: Array<{
		accountId: string
		databaseName: string
	}>
}

export type CreatedD1Target = {
	uuid: string
	name: string
	createdAt: string
}

export type VerificationPhase = 'baseline' | 'post-forward'

export type Command = {
	kind: 'import' | 'migration' | 'provision' | 'verification'
	phase?: VerificationPhase
	program: string
	args: Array<string>
}

export type VerificationQuery = {
	id:
		| 'foreign-keys'
		| 'integrity'
		| 'isolation'
		| 'migrations'
		| 'schema'
		| 'sequences'
	phase: VerificationPhase
	sql: string
}

export type QueryRow = Record<string, string | number | null>

export type TemporaryWranglerConfig = {
	path: string
	cleanup(): Promise<void>
}

export type DrillAdapters = {
	createTarget(input: {
		accountId: string
		name: string
	}): Promise<CreatedD1Target>
	writeTemporaryConfig(input: {
		targetName: string
		targetUuid: string
	}): Promise<TemporaryWranglerConfig>
	now(): Date
	run(command: Command): Promise<void>
	query(command: Command, query: VerificationQuery): Promise<Array<QueryRow>>
}

export type BackupFileEvidence = {
	sizeBytes: number
	sha256: string
}

export type DrillInput = {
	manifestBytes: Uint8Array
	expectedManifestSha256: string
	manifestPublicKeyRegistry: unknown
	backupFileEvidence: BackupFileEvidence
	backupFile: string
	baselineId: string
	postForwardBaselineId?: string
	baselineRegistry: unknown
	targetAccountId: string
	targetName: string
	trustRegistry: unknown
	applyForwardMigrations?: boolean
	dryRun?: boolean
}

function assertRecord(
	value: unknown,
	label: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`)
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	keys: ReadonlyArray<string>,
	label: string,
): void {
	const actual = Object.keys(value).sort()
	const expected = [...keys].sort()
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`${label} has an invalid shape`)
	}
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`)
	}
}

function assertHash(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !sha256Pattern.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest`)
	}
}

function assertDate(value: unknown, label: string): asserts value is string {
	assertString(value, label)
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`${label} must be an ISO date`)
	}
}

function assertIdentifier(
	value: unknown,
	label: string,
): asserts value is string {
	assertString(value, label)
	if (!identifierPattern.test(value)) {
		throw new Error(`${label} is not a safe SQLite identifier`)
	}
}

function deepFreeze<T extends Record<string, unknown>>(value: T): Readonly<T> {
	for (const child of Object.values(value)) {
		if (child && typeof child === 'object') {
			deepFreeze(child as Record<string, unknown>)
		}
	}
	return Object.freeze(value)
}

export function parseAndVerifyManifest(
	manifestBytes: Uint8Array,
	expectedManifestSha256: string,
	manifestPublicKeyRegistry: unknown,
): Readonly<BackupManifest> {
	const manifest = verifyTrustedBackupManifest(
		manifestBytes,
		expectedManifestSha256,
		manifestPublicKeyRegistry,
	)
	if (!uuidPattern.test(manifest.payload.source.databaseId)) {
		throw new Error('manifest.source.databaseId must be a UUID')
	}
	if (manifest.payload.sql.bytes >= maximumD1BackupSizeBytes) {
		throw new Error('D1 backup exceeds the 5 GiB restore-drill limit')
	}
	return manifest
}

export function parseBaseline(
	value: unknown,
	label = 'baseline',
): Readonly<RestoreBaseline> {
	assertRecord(value, label)
	assertExactKeys(
		value,
		[
			'isolationChecks',
			'migrationNames',
			'schemaSha256',
			'schemaVersion',
			'sequenceTables',
			'sourceDatabaseId',
		],
		label,
	)
	if (value.schemaVersion !== 1)
		throw new Error(`${label}.schemaVersion must be 1`)
	assertString(value.sourceDatabaseId, `${label}.sourceDatabaseId`)
	if (!uuidPattern.test(value.sourceDatabaseId)) {
		throw new Error(`${label}.sourceDatabaseId must be a UUID`)
	}
	assertHash(value.schemaSha256, `${label}.schemaSha256`)
	if (
		!Array.isArray(value.migrationNames) ||
		!value.migrationNames.every(
			(item) => typeof item === 'string' && item.length > 0,
		)
	) {
		throw new Error(`${label}.migrationNames must contain migration names`)
	}
	if (!Array.isArray(value.sequenceTables)) {
		throw new Error(`${label}.sequenceTables must be an array`)
	}
	for (const table of value.sequenceTables) {
		assertIdentifier(table, `${label}.sequenceTables entry`)
	}
	if (
		!Array.isArray(value.isolationChecks) ||
		value.isolationChecks.length === 0
	) {
		throw new Error(`${label}.isolationChecks must contain checks`)
	}
	for (const check of value.isolationChecks) {
		assertRecord(check, `${label} isolation check`)
		assertExactKeys(
			check,
			['primaryKeyColumn', 'table', 'userColumn', 'users'],
			`${label} isolation check`,
		)
		assertIdentifier(check.table, `${label} isolation table`)
		assertIdentifier(check.userColumn, `${label} isolation user column`)
		assertIdentifier(check.primaryKeyColumn, `${label} isolation primary key`)
		if (!Array.isArray(check.users) || check.users.length !== 2) {
			throw new Error(`${label} isolation check must contain exactly two users`)
		}
		const userIds = new Set<string>()
		for (const user of check.users) {
			assertRecord(user, `${label} isolation user`)
			assertExactKeys(
				user,
				['primaryKeySha256', 'rowCount', 'userId'],
				`${label} isolation user`,
			)
			assertString(user.userId, `${label} isolation userId`)
			assertHash(user.primaryKeySha256, `${label} isolation primaryKeySha256`)
			if (
				!Number.isSafeInteger(user.rowCount) ||
				(user.rowCount as number) < 0
			) {
				throw new Error(`${label} isolation rowCount is invalid`)
			}
			userIds.add(user.userId)
		}
		if (userIds.size !== 2) {
			throw new Error(`${label} isolation users must be distinct`)
		}
	}
	return deepFreeze(value) as Readonly<RestoreBaseline>
}

export function parseRestoreTrustRegistry(
	value: unknown,
): Readonly<RestoreTrustRegistry> {
	assertRecord(value, 'restore trust registry')
	assertExactKeys(
		value,
		['drillTargets', 'productionSources', 'schemaVersion'],
		'restore trust registry',
	)
	if (value.schemaVersion !== 1) {
		throw new Error('restore trust registry schemaVersion must be 1')
	}
	if (!Array.isArray(value.productionSources)) {
		throw new Error('restore trust registry productionSources must be an array')
	}
	if (!Array.isArray(value.drillTargets)) {
		throw new Error('restore trust registry drillTargets must be an array')
	}
	const productionIdentities = new Set<string>()
	const productionAccounts = new Set<string>()
	for (const source of value.productionSources) {
		assertRecord(source, 'restore trust registry production source')
		assertExactKeys(
			source,
			['accountId', 'databaseId', 'databaseName'],
			'restore trust registry production source',
		)
		assertString(
			source.accountId,
			'restore trust registry production source accountId',
		)
		if (!cloudflareAccountIdPattern.test(source.accountId)) {
			throw new Error(
				'restore trust registry production source accountId must be a Cloudflare account ID',
			)
		}
		assertString(
			source.databaseId,
			'restore trust registry production source databaseId',
		)
		if (!uuidPattern.test(source.databaseId)) {
			throw new Error(
				'restore trust registry production source databaseId must be a UUID',
			)
		}
		assertString(
			source.databaseName,
			'restore trust registry production source databaseName',
		)
		const identity = canonicalJson(source)
		if (productionIdentities.has(identity)) {
			throw new Error(
				'restore trust registry has a duplicate production source',
			)
		}
		productionIdentities.add(identity)
		productionAccounts.add(source.accountId.toLowerCase())
	}
	const drillIdentities = new Set<string>()
	for (const target of value.drillTargets) {
		assertRecord(target, 'restore trust registry drill target')
		assertExactKeys(
			target,
			['accountId', 'databaseName'],
			'restore trust registry drill target',
		)
		assertString(
			target.accountId,
			'restore trust registry drill target accountId',
		)
		if (!cloudflareAccountIdPattern.test(target.accountId)) {
			throw new Error(
				'restore trust registry drill target accountId must be a Cloudflare account ID',
			)
		}
		assertString(
			target.databaseName,
			'restore trust registry drill target databaseName',
		)
		if (productionAccounts.has(target.accountId.toLowerCase())) {
			throw new Error(
				'restore trust registry drill target account must differ from every production account',
			)
		}
		const identity = canonicalJson(target)
		if (drillIdentities.has(identity)) {
			throw new Error('restore trust registry has a duplicate drill target')
		}
		drillIdentities.add(identity)
	}
	return deepFreeze(value) as Readonly<RestoreTrustRegistry>
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

function quoteSqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

export function buildVerificationQueries(
	baseline: Readonly<RestoreBaseline>,
	phase: VerificationPhase,
): Array<VerificationQuery> {
	const sequenceSql =
		baseline.sequenceTables.length === 0
			? 'SELECT 1 AS sequence_safe WHERE 1 = 0'
			: baseline.sequenceTables
					.map((table) => {
						const name = quoteSqlString(table)
						return `SELECT ${name} AS table_name, s.seq AS sequence_value, COALESCE(MAX(t.rowid), 0) AS max_rowid FROM sqlite_sequence s LEFT JOIN ${quoteIdentifier(table)} t ON 1 = 1 WHERE s.name = ${name}`
					})
					.join(' UNION ALL ')
	const isolationSql = baseline.isolationChecks
		.map((check) => {
			const users = check.users.map((user) => quoteSqlString(user.userId))
			return `SELECT ${quoteSqlString(check.table)} AS table_name, ${quoteIdentifier(check.userColumn)} AS user_id, ${quoteIdentifier(check.primaryKeyColumn)} AS primary_key FROM ${quoteIdentifier(check.table)} WHERE ${quoteIdentifier(check.userColumn)} IN (${users.join(',')})`
		})
		.join(' UNION ALL ')
	const orderedIsolationSql = `${isolationSql} ORDER BY table_name, user_id, primary_key`
	return [
		{ id: 'integrity', phase, sql: 'PRAGMA quick_check' },
		{ id: 'foreign-keys', phase, sql: 'PRAGMA foreign_key_check' },
		{
			id: 'migrations',
			phase,
			sql: 'SELECT name FROM d1_migrations ORDER BY name',
		},
		{
			id: 'schema',
			phase,
			sql: "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		},
		{ id: 'sequences', phase, sql: sequenceSql },
		{ id: 'isolation', phase, sql: orderedIsolationSql },
	]
}

function verificationCommands(
	configPath: string,
	queries: ReadonlyArray<VerificationQuery>,
): Array<Command> {
	return queries.map((query) => ({
		kind: 'verification',
		phase: query.phase,
		program: 'wrangler',
		args: [
			'd1',
			'execute',
			'D1_RESTORE_TARGET',
			'--remote',
			'--config',
			configPath,
			'--json',
			'--command',
			query.sql,
		],
	}))
}

export function buildDrillCommands(input: {
	backupFile: string
	targetAccountId: string
	targetName: string
	configPath: string
	baseline: Readonly<RestoreBaseline>
	applyForwardMigrations: boolean
	postForwardBaseline?: Readonly<RestoreBaseline>
}): Array<Command> {
	const commands: Array<Command> = [
		{
			kind: 'provision',
			program: 'cloudflare-api',
			args: [
				'POST',
				`/accounts/${input.targetAccountId}/d1/database`,
				JSON.stringify({ name: input.targetName }),
			],
		},
		{
			kind: 'import',
			program: 'wrangler',
			args: [
				'd1',
				'execute',
				'D1_RESTORE_TARGET',
				'--remote',
				'--config',
				input.configPath,
				'--file',
				input.backupFile,
			],
		},
		...verificationCommands(
			input.configPath,
			buildVerificationQueries(input.baseline, 'baseline'),
		),
	]
	if (input.applyForwardMigrations) {
		commands.push({
			kind: 'migration',
			program: 'wrangler',
			args: [
				'd1',
				'migrations',
				'apply',
				'D1_RESTORE_TARGET',
				'--remote',
				'--config',
				input.configPath,
			],
		})
	}
	if (input.postForwardBaseline) {
		commands.push(
			...verificationCommands(
				input.configPath,
				buildVerificationQueries(input.postForwardBaseline, 'post-forward'),
			),
		)
	}
	return commands
}

function assertTargetRequest(
	manifest: Readonly<BackupManifest>,
	targetAccountId: string,
	targetName: string,
	trustRegistry: Readonly<RestoreTrustRegistry>,
): void {
	assertString(targetAccountId, 'targetAccountId')
	assertString(targetName, 'targetName')
	if (
		!trustRegistry.productionSources.some(
			(source) =>
				source.accountId.toLowerCase() ===
					manifest.payload.source.accountId.toLowerCase() &&
				source.databaseId.toLowerCase() ===
					manifest.payload.source.databaseId.toLowerCase() &&
				source.databaseName === manifest.payload.source.databaseName,
		)
	) {
		throw new Error(
			'manifest source identity is not approved by the restore trust registry',
		)
	}
	if (
		targetAccountId.toLowerCase() ===
		manifest.payload.source.accountId.toLowerCase()
	) {
		throw new Error('target account must differ from the production account')
	}
	if (targetName === manifest.payload.source.databaseName) {
		throw new Error('target name is the production database name')
	}
	if (
		!trustRegistry.drillTargets.some(
			(target) =>
				target.accountId.toLowerCase() === targetAccountId.toLowerCase() &&
				target.databaseName === targetName,
		)
	) {
		throw new Error(
			'target account/name is not approved by the restore trust registry',
		)
	}
}

function assertCreatedTarget(
	created: CreatedD1Target,
	requestedName: string,
	creationStartedAt: Date,
	creationCompletedAt: Date,
	manifest: Readonly<BackupManifest>,
): void {
	assertString(created.uuid, 'created target UUID')
	if (!uuidPattern.test(created.uuid)) {
		throw new Error('Cloudflare returned an invalid target UUID')
	}
	if (
		created.uuid.toLowerCase() ===
		manifest.payload.source.databaseId.toLowerCase()
	) {
		throw new Error('Cloudflare returned the production database UUID')
	}
	if (created.name !== requestedName) {
		throw new Error('Cloudflare returned a different target name')
	}
	assertDate(created.createdAt, 'created target created_at')
	const createdAt = Date.parse(created.createdAt)
	const clockSkewMs = 5 * 60 * 1000
	if (
		createdAt < creationStartedAt.getTime() - clockSkewMs ||
		createdAt > creationCompletedAt.getTime() + clockSkewMs
	) {
		throw new Error('Cloudflare target created_at is outside creation window')
	}
}

export function verifyRows(
	query: VerificationQuery,
	rows: Array<QueryRow>,
	baseline: Readonly<RestoreBaseline>,
): void {
	switch (query.id) {
		case 'integrity': {
			if (rows.length !== 1) {
				throw new Error(`${query.phase} PRAGMA quick_check failed`)
			}
			const quickCheckEntries = Object.entries(rows[0] ?? {})
			if (
				quickCheckEntries.length !== 1 ||
				quickCheckEntries[0]?.[0].toLowerCase() !== 'quick_check' ||
				typeof quickCheckEntries[0]?.[1] !== 'string' ||
				quickCheckEntries[0][1].toLowerCase() !== 'ok'
			) {
				throw new Error(`${query.phase} PRAGMA quick_check failed`)
			}
			return
		}
		case 'foreign-keys':
			if (rows.length !== 0) {
				throw new Error(`${query.phase} PRAGMA foreign_key_check failed`)
			}
			return
		case 'migrations': {
			const actual = rows.map((row) => String(row.name)).sort()
			if (
				canonicalJson(actual) !==
				canonicalJson([...baseline.migrationNames].sort())
			) {
				throw new Error(`${query.phase} migration parity check failed`)
			}
			return
		}
		case 'schema':
			if (sha256(canonicalJson(rows)) !== baseline.schemaSha256) {
				throw new Error(`${query.phase} schema parity check failed`)
			}
			return
		case 'sequences':
			if (
				rows.length !== baseline.sequenceTables.length ||
				rows.some(
					(row) =>
						typeof row.table_name !== 'string' ||
						!baseline.sequenceTables.includes(row.table_name) ||
						typeof row.sequence_value !== 'number' ||
						typeof row.max_rowid !== 'number' ||
						row.sequence_value < row.max_rowid,
				)
			) {
				throw new Error(`${query.phase} sqlite_sequence safety check failed`)
			}
			return
		case 'isolation': {
			const primaryKeys = new Set<string>()
			for (const check of baseline.isolationChecks) {
				const tableRows = rows.filter((row) => row.table_name === check.table)
				for (const expected of check.users) {
					const keys = tableRows
						.filter(
							(row) =>
								(typeof row.user_id === 'string' ||
									typeof row.user_id === 'number') &&
								String(row.user_id) === expected.userId,
						)
						.map((row) => String(row.primary_key))
					if (
						keys.length !== expected.rowCount ||
						sha256(canonicalJson(keys)) !== expected.primaryKeySha256
					) {
						throw new Error(
							`${query.phase} two-user isolation check failed for ${check.table}/${expected.userId}`,
						)
					}
					for (const key of keys) {
						const scopedKey = `${check.table}\0${key}`
						if (primaryKeys.has(scopedKey)) {
							throw new Error(
								`${query.phase} isolation found a shared primary key`,
							)
						}
						primaryKeys.add(scopedKey)
					}
				}
			}
			return
		}
		default: {
			const exhaustive: never = query.id
			throw new Error(`Unhandled verification query: ${String(exhaustive)}`)
		}
	}
}

async function verifyBaseline(
	adapters: DrillAdapters,
	configPath: string,
	baseline: Readonly<RestoreBaseline>,
	phase: VerificationPhase,
): Promise<void> {
	const queries = buildVerificationQueries(baseline, phase)
	const commands = verificationCommands(configPath, queries)
	for (const [index, query] of queries.entries()) {
		const command = commands[index]
		if (!command) throw new Error('restore plan lacks verification command')
		verifyRows(query, await adapters.query(command, query), baseline)
	}
}

export async function runD1RestoreDrill(
	input: DrillInput,
	adapters: DrillAdapters,
): Promise<{ dryRun: boolean; commands: Array<Command> }> {
	const manifest = parseAndVerifyManifest(
		input.manifestBytes,
		input.expectedManifestSha256,
		input.manifestPublicKeyRegistry,
	)
	const trustRegistry = parseRestoreTrustRegistry(input.trustRegistry)
	assertTargetRequest(
		manifest,
		input.targetAccountId,
		input.targetName,
		trustRegistry,
	)
	const baseline = resolveTrustedRestoreBaseline({
		id: input.baselineId,
		manifest,
		registryValue: input.baselineRegistry,
		restoreTrustRegistry: trustRegistry,
		parseBaseline,
		requireManifestDigest: true,
	})
	const postForwardBaseline = input.postForwardBaselineId
		? resolveTrustedRestoreBaseline({
				id: input.postForwardBaselineId,
				manifest,
				registryValue: input.baselineRegistry,
				restoreTrustRegistry: trustRegistry,
				parseBaseline,
				requireManifestDigest: false,
			})
		: undefined
	const applyForwardMigrations = input.applyForwardMigrations ?? false
	if (postForwardBaseline && !applyForwardMigrations) {
		throw new Error('post-forward baseline requires forward migrations')
	}
	if (applyForwardMigrations && !postForwardBaseline) {
		throw new Error('forward migrations require a post-forward baseline')
	}
	if (
		input.backupFileEvidence.sizeBytes !== manifest.payload.sql.bytes ||
		input.backupFileEvidence.sha256 !== manifest.payload.sql.sha256
	) {
		throw new Error('local SQL file evidence does not match the manifest')
	}
	const dryRun = input.dryRun ?? true
	const plan = buildDrillCommands({
		backupFile: input.backupFile,
		targetAccountId: input.targetAccountId,
		targetName: input.targetName,
		configPath: '<temporary-wrangler-config>',
		baseline,
		applyForwardMigrations,
		postForwardBaseline,
	})
	if (dryRun) return { dryRun, commands: plan }

	const creationStartedAt = adapters.now()
	const created = await adapters.createTarget({
		accountId: input.targetAccountId,
		name: input.targetName,
	})
	const creationCompletedAt = adapters.now()
	if (
		!Number.isFinite(creationStartedAt.getTime()) ||
		!Number.isFinite(creationCompletedAt.getTime()) ||
		creationCompletedAt < creationStartedAt
	) {
		throw new Error('invalid creation clock evidence')
	}
	assertCreatedTarget(
		created,
		input.targetName,
		creationStartedAt,
		creationCompletedAt,
		manifest,
	)
	const temporaryConfig = await adapters.writeTemporaryConfig({
		targetName: created.name,
		targetUuid: created.uuid,
	})
	try {
		const commands = buildDrillCommands({
			backupFile: input.backupFile,
			targetAccountId: input.targetAccountId,
			targetName: input.targetName,
			configPath: temporaryConfig.path,
			baseline,
			applyForwardMigrations,
			postForwardBaseline,
		})
		const importCommand = commands.find((command) => command.kind === 'import')
		if (!importCommand) {
			throw new Error('restore plan is missing its import command')
		}
		await adapters.run(importCommand)
		await verifyBaseline(adapters, temporaryConfig.path, baseline, 'baseline')
		if (applyForwardMigrations) {
			const migrationCommand = commands.find(
				(command) => command.kind === 'migration',
			)
			if (!migrationCommand)
				throw new Error('restore plan lacks migration command')
			await adapters.run(migrationCommand)
		}
		if (postForwardBaseline) {
			await verifyBaseline(
				adapters,
				temporaryConfig.path,
				postForwardBaseline,
				'post-forward',
			)
		}
		return { dryRun, commands }
	} finally {
		await temporaryConfig.cleanup()
	}
}
