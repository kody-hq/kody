import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	resolveCurrentPullNumber,
	scanOpenPullRequestMigrationPrefixes,
	type OpenPullRequestFileClaim,
	type OpenPullRequestMigrationScan,
} from './open-pull-request-migration-prefixes.ts'

const execFileAsync = promisify(execFile)

export const defaultMigrationsDir = path.join(
	'packages',
	'worker',
	'migrations',
)
export const defaultMigrationLedgerPath = path.join(
	'tools',
	'migration-ledger.json',
)
export const defaultMigrationRepairsPath = path.join(
	'tools',
	'migration-repairs.json',
)

export type MigrationRepair = {
	filename: string
	fromSha256: string
	toSha256: string
	reason: string
}

export type MigrationRepairsFile = {
	version: 1
	repairs: Array<MigrationRepair>
}
export const defaultKnownMigrationDirectories: ReadonlyArray<string> = [
	defaultMigrationsDir,
	path.join('packages', 'jobs-worker', 'migrations'),
	path.join('packages', 'worker', 'audit-migrations'),
]
export const defaultMigrationReferenceRoots: ReadonlyArray<string> = [
	'docs',
	path.join('packages', 'worker', 'src'),
	path.join('packages', 'worker', 'universal'),
]
export const expectedMigrationBaselineSha256 =
	'aee006f0719e4d967b7485fb3199f8e2eb0660258b7720661b7fc48ce67fc199'

const migrationFilenameReferencePattern =
	/\b(?<filename>\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*)\.sql\b/g

const placeholderMigrationDescriptions = new Set([
	'my-change',
	'your-change',
	'kebab-case-description',
])

const migrationReferenceFilePattern = /\.(?:md|mdx|mdc|ts|tsx)$/

const skipMigrationReferenceDirectoryNames = new Set([
	'node_modules',
	'.git',
	'dist',
	'.tmp',
])

/** Point-in-time records may name pre-squash or retired files. */
export const exemptMigrationReferencePrefixes: ReadonlyArray<string> = [
	'docs/contributing/decisions/',
	'docs/audits/',
]

/**
 * Exact grandfathered duplicate-prefix pairs. The 2026-08-04 migration
 * squash (0001-squashed-init.sql) retired every historical duplicate, so
 * this list is empty; new duplicates are always rejected.
 */
export const allowedHistoricalDuplicateMigrationFilenames: ReadonlyArray<string> =
	[]

const allowedHistoricalDuplicateMigrationFilenameSet = new Set<string>(
	allowedHistoricalDuplicateMigrationFilenames,
)

const migrationFilenamePattern =
	/^(?<prefix>\d{4})-(?<description>[a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/

export type ParsedMigrationFilename = {
	prefix: string
	description: string
}

export type MigrationFilenameCheckResult = {
	ok: boolean
	errors: Array<string>
	nextPrefix: string
	maxPrefix: number
}

type MigrationFilenameReferenceFile = {
	path: string
	content: string
}

export type MigrationLedgerEntry = {
	filename: string
	sha256: string
}

export type MigrationLedger = {
	version: 1
	baselineCount: number
	baselineMaximumPrefix: number
	baselineSha256: string
	migrations: Array<MigrationLedgerEntry>
}

export type TrustedMigrationHistory = {
	ref: string
	files: Array<MigrationLedgerEntry>
	ledgerEntries: Array<MigrationLedgerEntry>
	/**
	 * The trusted ref's own frozen baseline digest, or null when the ref has
	 * no ledger. When this differs from the current
	 * `expectedMigrationBaselineSha256`, the trusted ref sits on the other
	 * side of a migration squash and its per-file history is incomparable;
	 * cross-history checks are skipped for exactly that one transition while
	 * the frozen baseline and ledger integrity checks keep protecting the
	 * current epoch.
	 */
	ledgerBaselineSha256: string | null
}

type GitOutput = (
	args: ReadonlyArray<string>,
	options?: { trim?: boolean },
) => Promise<string | null>

export type TrustedMigrationBaseOptions = {
	env?: NodeJS.ProcessEnv
	git?: GitOutput
}

export function parseMigrationFilename(
	filename: string,
): ParsedMigrationFilename | null {
	const match = migrationFilenamePattern.exec(filename)
	if (!match?.groups) {
		return null
	}
	const prefix = match.groups.prefix
	const description = match.groups.description
	if (!prefix || !description) {
		return null
	}
	return { prefix, description }
}

export function getMaxMigrationPrefix(
	filenames: ReadonlyArray<string>,
): number {
	let maxPrefix = 0
	for (const filename of filenames) {
		const parsed = parseMigrationFilename(filename)
		if (!parsed) {
			continue
		}
		maxPrefix = Math.max(maxPrefix, Number(parsed.prefix))
	}
	return maxPrefix
}

export function formatMigrationPrefix(prefix: number): string {
	return String(prefix).padStart(4, '0')
}

export function getNextMigrationPrefix(
	filenames: ReadonlyArray<string>,
): string {
	return formatMigrationPrefix(getMaxMigrationPrefix(filenames) + 1)
}

function suggestNextPrefix(nextPrefix: string): string {
	return `Use the next free prefix ${nextPrefix} (for example, ${nextPrefix}-your-change.sql).`
}

export function isPlaceholderMigrationFilename(filename: string) {
	const parsed = parseMigrationFilename(filename)
	return (
		parsed !== null && placeholderMigrationDescriptions.has(parsed.description)
	)
}

export function collectMigrationFilenameReferences(content: string) {
	const filenames: Array<string> = []
	const seen = new Set<string>()
	for (const match of content.matchAll(migrationFilenameReferencePattern)) {
		const filename = match.groups?.filename
		if (!filename) {
			continue
		}
		const withExtension = `${filename}.sql`
		if (seen.has(withExtension)) {
			continue
		}
		seen.add(withExtension)
		filenames.push(withExtension)
	}
	return filenames
}

export function checkMigrationFilenameReferences(input: {
	knownFilenames: ReadonlySet<string>
	files: ReadonlyArray<MigrationFilenameReferenceFile>
}): Array<string> {
	const errors: Array<string> = []
	for (const file of input.files) {
		if (
			exemptMigrationReferencePrefixes.some((prefix) =>
				file.path.startsWith(prefix),
			)
		) {
			continue
		}
		for (const filename of collectMigrationFilenameReferences(file.content)) {
			if (input.knownFilenames.has(filename)) {
				continue
			}
			if (isPlaceholderMigrationFilename(filename)) {
				continue
			}
			errors.push(
				`${file.path} references migration "${filename}", which is not in ${defaultMigrationsDir} (or jobs/audit migration directories). After a renumber, update the reference to the current filename.`,
			)
		}
	}
	return errors
}

async function readExistingDirectoryEntries(directory: string) {
	try {
		return await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return []
		}
		throw error
	}
}

async function collectMigrationReferenceFiles(
	directory: string,
	relativePrefix: string,
): Promise<Array<MigrationFilenameReferenceFile>> {
	const entries = await readExistingDirectoryEntries(directory)
	const files: Array<MigrationFilenameReferenceFile> = []
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (skipMigrationReferenceDirectoryNames.has(entry.name)) {
				continue
			}
			files.push(
				...(await collectMigrationReferenceFiles(
					path.join(directory, entry.name),
					`${relativePrefix}/${entry.name}`,
				)),
			)
			continue
		}
		if (!entry.isFile() || !migrationReferenceFilePattern.test(entry.name)) {
			continue
		}
		const relativePath = `${relativePrefix}/${entry.name}`.replaceAll('\\', '/')
		files.push({
			path: relativePath,
			content: await readFile(path.join(directory, entry.name), 'utf8'),
		})
	}
	return files
}

export async function listKnownMigrationFilenames(
	directories: ReadonlyArray<string> = defaultKnownMigrationDirectories,
): Promise<Set<string>> {
	const filenames = new Set<string>()
	for (const directory of directories) {
		const entries = await readExistingDirectoryEntries(directory)
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.sql')) {
				filenames.add(entry.name)
			}
		}
	}
	return filenames
}

export async function checkRepositoryMigrationFilenameReferences(
	cwd: string = process.cwd(),
	roots: ReadonlyArray<string> = defaultMigrationReferenceRoots,
	knownDirectories: ReadonlyArray<string> = defaultKnownMigrationDirectories,
): Promise<Array<string>> {
	const knownFilenames = await listKnownMigrationFilenames(
		knownDirectories.map((directory) => path.join(cwd, directory)),
	)
	const files: Array<MigrationFilenameReferenceFile> = []
	for (const root of roots) {
		files.push(
			...(await collectMigrationReferenceFiles(path.join(cwd, root), root)),
		)
	}
	return checkMigrationFilenameReferences({ knownFilenames, files })
}

export function checkMigrationFilenames(
	filenames: ReadonlyArray<string>,
): MigrationFilenameCheckResult {
	const sortedFilenames = [...filenames].sort()
	const maxPrefix = getMaxMigrationPrefix(sortedFilenames)
	const nextPrefix = formatMigrationPrefix(maxPrefix + 1)
	const errors: Array<string> = []
	const filesByPrefix = new Map<string, Array<string>>()

	for (const filename of sortedFilenames) {
		const parsed = parseMigrationFilename(filename)
		if (!parsed) {
			errors.push(
				`Invalid migration filename "${filename}". Expected NNNN-kebab-case-description.sql with a 4-digit prefix and lowercase kebab-case segments. ${suggestNextPrefix(nextPrefix)}`,
			)
			continue
		}

		const filesForPrefix = filesByPrefix.get(parsed.prefix) ?? []
		filesForPrefix.push(filename)
		filesByPrefix.set(parsed.prefix, filesForPrefix)
	}

	const prefixes = [...filesByPrefix.keys()].sort()
	for (const prefix of prefixes) {
		const filesForPrefix = filesByPrefix.get(prefix)
		if (!filesForPrefix || filesForPrefix.length <= 1) {
			continue
		}

		const disallowedFiles = filesForPrefix.filter(
			(filename) =>
				!allowedHistoricalDuplicateMigrationFilenameSet.has(filename),
		)
		const isAllowedHistoricalPair =
			disallowedFiles.length === 0 && filesForPrefix.length === 2

		if (isAllowedHistoricalPair) {
			continue
		}

		const allowedPairForPrefix = allowedHistoricalDuplicateMigrationFilenames
			.filter((filename) => filename.startsWith(`${prefix}-`))
			.join(', ')

		if (allowedPairForPrefix.length > 0) {
			const offendingFiles =
				disallowedFiles.length > 0 ? disallowedFiles : filesForPrefix
			errors.push(
				`Duplicate migration prefix ${prefix} is only allowed for the grandfathered pair (${allowedPairForPrefix}). Offending file(s): ${offendingFiles.join(', ')}. Files with this prefix: ${filesForPrefix.join(', ')}. ${suggestNextPrefix(nextPrefix)}`,
			)
			continue
		}

		errors.push(
			`Duplicate migration prefix ${prefix}: ${filesForPrefix.join(', ')}. ${suggestNextPrefix(nextPrefix)}`,
		)
	}

	return {
		ok: errors.length === 0,
		errors,
		nextPrefix,
		maxPrefix,
	}
}

export function hashMigrationContent(value: string | Uint8Array): string {
	const text =
		typeof value === 'string' ? value : new TextDecoder().decode(value)
	const canonicalLfText = text.replace(/\r\n?/g, '\n')
	return createHash('sha256').update(canonicalLfText).digest('hex')
}

function getBaselineSha256(
	entries: ReadonlyArray<MigrationLedgerEntry>,
): string {
	return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export function isMigrationLedger(value: unknown): value is MigrationLedger {
	if (!value || typeof value !== 'object') {
		return false
	}
	const candidate = value as Partial<MigrationLedger>
	return (
		candidate.version === 1 &&
		Number.isInteger(candidate.baselineCount) &&
		Number.isInteger(candidate.baselineMaximumPrefix) &&
		typeof candidate.baselineSha256 === 'string' &&
		Array.isArray(candidate.migrations) &&
		candidate.migrations.every(
			(entry) =>
				entry !== null &&
				typeof entry === 'object' &&
				typeof entry.filename === 'string' &&
				typeof entry.sha256 === 'string' &&
				/^[a-f0-9]{64}$/.test(entry.sha256),
		)
	)
}

export function isMigrationRepairsFile(
	value: unknown,
): value is MigrationRepairsFile {
	if (!value || typeof value !== 'object') {
		return false
	}
	const candidate = value as MigrationRepairsFile
	return (
		candidate.version === 1 &&
		Array.isArray(candidate.repairs) &&
		candidate.repairs.every(
			(entry) =>
				entry !== null &&
				typeof entry === 'object' &&
				typeof entry.filename === 'string' &&
				typeof entry.fromSha256 === 'string' &&
				/^[a-f0-9]{64}$/.test(entry.fromSha256) &&
				typeof entry.toSha256 === 'string' &&
				/^[a-f0-9]{64}$/.test(entry.toSha256) &&
				typeof entry.reason === 'string' &&
				entry.reason.trim().length > 0,
		)
	)
}

/**
 * One-shot allowlist for rewriting a migration that landed on `main` but never
 * applied successfully (D1 rolled back before `d1_migrations` recorded it).
 * Match is filename + trusted fromSha256 + approved toSha256 only.
 */
export function isAllowedMigrationRepair(input: {
	filename: string
	fromSha256: string
	toSha256: string
	repairs: ReadonlyArray<MigrationRepair>
}): boolean {
	if (input.fromSha256 === input.toSha256) {
		return false
	}
	return input.repairs.some(
		(repair) =>
			repair.filename === input.filename &&
			repair.fromSha256 === input.fromSha256 &&
			repair.toSha256 === input.toSha256,
	)
}

export function checkMigrationLedger(
	files: ReadonlyArray<MigrationLedgerEntry>,
	ledger: MigrationLedger,
	trustedHistory: TrustedMigrationHistory | null = null,
	repairs: ReadonlyArray<MigrationRepair> = [],
): MigrationFilenameCheckResult {
	const filenames = files.map(({ filename }) => filename)
	const filenameResult = checkMigrationFilenames(filenames)
	const errors = [...filenameResult.errors]
	const ledgerFilenames = ledger.migrations.map(({ filename }) => filename)
	const ledgerFilenameResult = checkMigrationFilenames(ledgerFilenames)

	if (ledger.baselineSha256 !== expectedMigrationBaselineSha256) {
		errors.push(
			`Migration ledger baseline digest changed. Baseline migrations are immutable; expected ${expectedMigrationBaselineSha256}.`,
		)
	}

	if (ledger.migrations.length < ledger.baselineCount) {
		errors.push(
			`Migration ledger contains ${String(ledger.migrations.length)} entries but its frozen baseline requires ${String(ledger.baselineCount)}.`,
		)
	} else {
		const baselineEntries = ledger.migrations.slice(0, ledger.baselineCount)
		const actualBaselineSha256 = getBaselineSha256(baselineEntries)
		if (actualBaselineSha256 !== ledger.baselineSha256) {
			errors.push(
				`Migration ledger baseline entries changed (expected digest ${ledger.baselineSha256}, received ${actualBaselineSha256}). Baseline entries cannot be edited, reordered, renamed, or deleted.`,
			)
		}
		const actualBaselineMaximum = getMaxMigrationPrefix(
			baselineEntries.map(({ filename }) => filename),
		)
		if (actualBaselineMaximum !== ledger.baselineMaximumPrefix) {
			errors.push(
				`Migration ledger baseline maximum is ${String(actualBaselineMaximum)}, not the recorded ${String(ledger.baselineMaximumPrefix)}.`,
			)
		}
	}

	if (!ledgerFilenameResult.ok) {
		errors.push(
			...ledgerFilenameResult.errors.map((error) => `Ledger: ${error}`),
		)
	}

	const sortedLedgerFilenames = [...ledgerFilenames].sort()
	if (
		sortedLedgerFilenames.some(
			(filename, index) => filename !== ledgerFilenames[index],
		)
	) {
		errors.push(
			'Migration ledger entries must remain in lexicographic filename order; append new migrations without reordering history.',
		)
	}

	for (const entry of ledger.migrations.slice(ledger.baselineCount)) {
		const parsed = parseMigrationFilename(entry.filename)
		if (parsed && Number(parsed.prefix) <= ledger.baselineMaximumPrefix) {
			errors.push(
				`Migration "${entry.filename}" was added at or below frozen baseline maximum ${formatMigrationPrefix(ledger.baselineMaximumPrefix)}. Additions must use a higher prefix.`,
			)
		}
	}

	const isCrossEpochTrustedHistory =
		trustedHistory !== null &&
		trustedHistory.ledgerBaselineSha256 !== null &&
		trustedHistory.ledgerBaselineSha256 !== expectedMigrationBaselineSha256
	const comparableTrustedHistory = isCrossEpochTrustedHistory
		? null
		: trustedHistory
	const fallbackEntries = ledger.migrations.slice(0, ledger.baselineCount)
	const trustedFiles = comparableTrustedHistory?.files ?? fallbackEntries
	const trustedLedgerEntries =
		comparableTrustedHistory?.ledgerEntries ?? fallbackEntries
	const trustedMaximumPrefix = getMaxMigrationPrefix(
		trustedFiles.map(({ filename }) => filename),
	)

	if (
		!trustedHistory &&
		(ledger.migrations.length > ledger.baselineCount ||
			files.length > ledger.baselineCount)
	) {
		errors.push(
			'Cannot verify post-baseline migration history because no trusted Git base is available. Fetch origin/main history (CI uses fetch-depth: 0) and rerun validation.',
		)
	}

	const filesByName = new Map(files.map((entry) => [entry.filename, entry]))
	const ledgerByName = new Map(
		ledger.migrations.map((entry) => [entry.filename, entry]),
	)

	for (const [index, trustedEntry] of trustedLedgerEntries.entries()) {
		const currentEntry = ledger.migrations[index]
		const repaired =
			currentEntry !== undefined &&
			currentEntry.filename === trustedEntry.filename &&
			isAllowedMigrationRepair({
				filename: trustedEntry.filename,
				fromSha256: trustedEntry.sha256,
				toSha256: currentEntry.sha256,
				repairs,
			})
		if (
			!currentEntry ||
			currentEntry.filename !== trustedEntry.filename ||
			(currentEntry.sha256 !== trustedEntry.sha256 && !repaired)
		) {
			errors.push(
				`Migration ledger history from ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'} changed at "${trustedEntry.filename}". Historical ledger entries cannot be edited, reordered, or deleted.`,
			)
		}
	}

	for (const entry of ledger.migrations) {
		const file = filesByName.get(entry.filename)
		if (!file) {
			errors.push(
				`Ledgered migration "${entry.filename}" is missing. Applied migrations cannot be deleted or renamed.`,
			)
		} else if (file.sha256 !== entry.sha256) {
			errors.push(
				`Ledgered migration "${entry.filename}" was modified (expected sha256 ${entry.sha256}, received ${file.sha256}). Applied migrations are immutable.`,
			)
		}
	}
	for (const file of files) {
		if (!ledgerByName.has(file.filename)) {
			errors.push(
				`Migration "${file.filename}" is not in ${defaultMigrationLedgerPath}. Append its filename and sha256 after choosing a prefix above the ledger maximum.`,
			)
		}
	}

	const trustedFilesByName = new Map(
		trustedFiles.map((entry) => [entry.filename, entry]),
	)
	for (const trustedFile of trustedFiles) {
		const currentFile = filesByName.get(trustedFile.filename)
		if (!currentFile) {
			errors.push(
				`Migration "${trustedFile.filename}" exists in trusted history ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'} but is missing from the checkout.`,
			)
		} else if (
			currentFile.sha256 !== trustedFile.sha256 &&
			!isAllowedMigrationRepair({
				filename: trustedFile.filename,
				fromSha256: trustedFile.sha256,
				toSha256: currentFile.sha256,
				repairs,
			})
		) {
			errors.push(
				`Migration "${trustedFile.filename}" differs from trusted history ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'}. Migration and ledger digests cannot be changed together.`,
			)
		}
	}
	for (const file of files) {
		if (trustedFilesByName.has(file.filename)) {
			continue
		}
		const parsed = parseMigrationFilename(file.filename)
		if (parsed && Number(parsed.prefix) <= trustedMaximumPrefix) {
			errors.push(
				`Migration "${file.filename}" is new relative to ${comparableTrustedHistory?.ref ?? 'the frozen bootstrap baseline'} but does not use a prefix above ${formatMigrationPrefix(trustedMaximumPrefix)}.`,
			)
		}
	}

	return {
		...filenameResult,
		ok: errors.length === 0,
		errors,
	}
}

export async function readMigrationLedger(
	ledgerPath: string = defaultMigrationLedgerPath,
): Promise<MigrationLedger> {
	const parsed: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'))
	if (!isMigrationLedger(parsed)) {
		throw new Error(`Invalid migration ledger structure in ${ledgerPath}.`)
	}
	return parsed
}

async function gitOutput(
	args: ReadonlyArray<string>,
	options: { trim?: boolean } = {},
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', [...args], {
			encoding: 'utf8',
		})
		return options.trim === false ? stdout : stdout.trim()
	} catch {
		return null
	}
}

export async function resolveTrustedMigrationBase(
	options: TrustedMigrationBaseOptions = {},
): Promise<string | null> {
	const env = options.env ?? process.env
	const git = options.git ?? gitOutput
	const head = await git(['rev-parse', 'HEAD^{commit}'])
	if (!head) {
		return null
	}

	const explicitCandidates = [
		env.MIGRATION_VALIDATION_BASE,
		env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined,
	].filter((candidate): candidate is string => Boolean(candidate))
	for (const candidate of explicitCandidates) {
		const commit = await git(['rev-parse', `${candidate}^{commit}`])
		if (commit && commit !== head) {
			return commit
		}
	}

	for (const candidate of ['origin/main', 'main']) {
		const mergeBase = await git(['merge-base', 'HEAD', candidate])
		if (mergeBase && mergeBase !== head) {
			return mergeBase
		}
	}

	const firstParent = await git(['rev-parse', 'HEAD^1'])
	return firstParent && firstParent !== head ? firstParent : null
}

export async function readTrustedMigrationHistory(
	ref: string,
): Promise<TrustedMigrationHistory> {
	const migrationRoot = defaultMigrationsDir.replaceAll(path.sep, '/')
	const filenamesOutput = await gitOutput([
		'ls-tree',
		'-r',
		'--name-only',
		ref,
		'--',
		migrationRoot,
	])
	if (filenamesOutput === null) {
		throw new Error(`Could not read migrations from trusted Git ref ${ref}.`)
	}
	const filenames = filenamesOutput
		.split('\n')
		.filter((filename) => filename.endsWith('.sql'))
		.map((filename) => path.posix.basename(filename))
		.sort()
	const files = await Promise.all(
		filenames.map(async (filename) => {
			const content = await gitOutput(
				['show', `${ref}:${migrationRoot}/${filename}`],
				{ trim: false },
			)
			if (content === null) {
				throw new Error(
					`Could not read migration "${filename}" from trusted Git ref ${ref}.`,
				)
			}
			return { filename, sha256: hashMigrationContent(content) }
		}),
	)

	const ledgerJson = await gitOutput(
		['show', `${ref}:${defaultMigrationLedgerPath.replaceAll(path.sep, '/')}`],
		{ trim: false },
	)
	let ledgerEntries = files
	let ledgerBaselineSha256: string | null = null
	if (ledgerJson !== null) {
		const parsed: unknown = JSON.parse(ledgerJson)
		if (!isMigrationLedger(parsed)) {
			throw new Error(
				`Invalid migration ledger structure at trusted Git ref ${ref}.`,
			)
		}
		ledgerEntries = parsed.migrations
		ledgerBaselineSha256 = parsed.baselineSha256
	}
	return { ref, files, ledgerEntries, ledgerBaselineSha256 }
}

export async function readMigrationRepairs(
	repairsPath: string = defaultMigrationRepairsPath,
): Promise<ReadonlyArray<MigrationRepair>> {
	let raw: string
	try {
		raw = await readFile(repairsPath, 'utf8')
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			error.code === 'ENOENT'
		) {
			return []
		}
		throw error
	}
	const parsed: unknown = JSON.parse(raw)
	if (!isMigrationRepairsFile(parsed)) {
		throw new Error(`Invalid migration repairs file at ${repairsPath}.`)
	}
	return parsed.repairs
}

export async function checkMigrationsDirectory(
	migrationsDir: string = defaultMigrationsDir,
	ledgerPath: string = defaultMigrationLedgerPath,
	repairsPath: string = defaultMigrationRepairsPath,
): Promise<
	MigrationFilenameCheckResult & { trustedFilenames: ReadonlyArray<string> }
> {
	const directoryEntries = await readdir(migrationsDir, {
		withFileTypes: true,
	})
	const filenames = directoryEntries
		.filter((entry) => entry.isFile())
		.map(({ name }) => name)
	const files = await Promise.all(
		filenames.map(async (filename) => ({
			filename,
			sha256: hashMigrationContent(
				await readFile(path.join(migrationsDir, filename)),
			),
		})),
	)
	const ledger = await readMigrationLedger(ledgerPath)
	const repairs = await readMigrationRepairs(repairsPath)
	const trustedBase = await resolveTrustedMigrationBase()
	const trustedHistory = trustedBase
		? await readTrustedMigrationHistory(trustedBase)
		: null
	const ledgerResult = checkMigrationLedger(
		files,
		ledger,
		trustedHistory,
		repairs,
	)
	const referenceErrors = await checkRepositoryMigrationFilenameReferences()
	const errors = [...ledgerResult.errors, ...referenceErrors]
	return {
		...ledgerResult,
		trustedFilenames: trustedHistory?.files.map((file) => file.filename) ?? [],
		ok: errors.length === 0,
		errors,
	}
}

/**
 * Returns the `rank`-th prefix (1-based, default 1) at or above `nextPrefix`
 * that no claim uses. Several pull requests renumbering away from one
 * contested prefix take distinct ranks so they do not collide again.
 */
export function suggestFreeMigrationPrefix(input: {
	nextPrefix: string
	claimedPrefixes: ReadonlyArray<string>
	rank?: number
}): string | null {
	if (!/^\d{4}$/.test(input.nextPrefix)) return null
	const claimed = new Set(
		input.claimedPrefixes.filter((prefix) => /^\d{4}$/.test(prefix)),
	)
	let remaining = Math.max(1, Math.floor(input.rank ?? 1))
	let prefix = Number(input.nextPrefix)
	while (prefix <= 9999) {
		if (!claimed.has(formatMigrationPrefix(prefix))) {
			remaining -= 1
			if (remaining === 0) return formatMigrationPrefix(prefix)
		}
		prefix += 1
	}
	return null
}

export type OpenPullRequestMigrationOverlap = {
	prefix: string
	pullNumbers: Array<number>
}

export type OpenPullRequestMigrationAdvisory = {
	suggestedPrefix: string
	lines: Array<string>
	warning: string | null
	/**
	 * New migration prefixes this checkout uses that other open PRs also claim.
	 * Skipped scans never report overlaps.
	 */
	overlaps: Array<OpenPullRequestMigrationOverlap>
	/**
	 * The overlaps this checkout must give up (#3592). Tie-break: the
	 * lowest-numbered open pull request keeps a contested prefix, so only the
	 * higher-numbered side of a collision renumbers. A base-branch checkout
	 * (push to main) never yields. Unknown PR numbers stay conservative and
	 * yield every overlap. Pull request checks fail when this is non-empty.
	 */
	blockingOverlaps: Array<OpenPullRequestMigrationOverlap>
}

/**
 * Lists prefixes claimed by other open pull requests and suggests the lowest
 * prefix at or above the local next that none of them use. Gaps stay allowed.
 * Missing auth is silent. A GitHub failure is a warning, not a check failure.
 * Pull request checks fail on `blockingOverlaps` only.
 */
export function formatOpenPullRequestMigrationAdvisory(input: {
	migrationsDir: string
	localFilenames: ReadonlyArray<string>
	/** Exact files already in trusted history cannot be renumbered for another PR. */
	trustedFilenames?: ReadonlyArray<string>
	localNextPrefix: string
	scan: OpenPullRequestMigrationScan
	/** This checkout's open pull request number, when known. */
	currentPullNumber?: number | null
	/** True for base-branch checkouts (push to main), which keep every prefix. */
	isBaseBranchCheckout?: boolean
}): OpenPullRequestMigrationAdvisory {
	switch (input.scan.status) {
		case 'skipped':
			return skippedMigrationPrefixAdvisory(input.localNextPrefix, input.scan)
		case 'ok':
			return claimedMigrationPrefixAdvisory({
				migrationsDir: input.migrationsDir,
				localFilenames: input.localFilenames.filter(
					(filename) => !input.trustedFilenames?.includes(filename),
				),
				localNextPrefix: input.localNextPrefix,
				scan: input.scan,
				currentPullNumber: input.currentPullNumber ?? null,
				isBaseBranchCheckout: input.isBaseBranchCheckout ?? false,
			})
		default: {
			const neverScan: never = input.scan
			throw new Error(`Unhandled open pull request scan: ${String(neverScan)}`)
		}
	}
}

function skippedMigrationPrefixAdvisory(
	localNextPrefix: string,
	scan: Extract<OpenPullRequestMigrationScan, { status: 'skipped' }>,
): OpenPullRequestMigrationAdvisory {
	switch (scan.reason) {
		case 'no-token':
		case 'no-repository':
			return {
				suggestedPrefix: localNextPrefix,
				lines: [],
				warning: null,
				overlaps: [],
				blockingOverlaps: [],
			}
		case 'unauthorized':
		case 'error':
			return {
				suggestedPrefix: localNextPrefix,
				lines: [],
				warning: `Open pull request migration prefix scan skipped: ${scan.detail ?? scan.reason}.`,
				overlaps: [],
				blockingOverlaps: [],
			}
		default: {
			const neverReason: never = scan.reason
			throw new Error(`Unhandled scan skip: ${String(neverReason)}`)
		}
	}
}

function claimedMigrationPrefixAdvisory(input: {
	migrationsDir: string
	localFilenames: ReadonlyArray<string>
	localNextPrefix: string
	scan: Extract<OpenPullRequestMigrationScan, { status: 'ok' }>
	currentPullNumber: number | null
	isBaseBranchCheckout: boolean
}): OpenPullRequestMigrationAdvisory {
	const claims = prefixesFromFileClaims(input.scan.claims)
	const claimedPrefixes = claims.flatMap((claim) => claim.prefixes)
	const grouped = groupClaimedPrefixes(claims)
	const localPrefixes = new Set(
		input.localFilenames.flatMap((filename) => {
			const parsed = parseMigrationFilename(filename)
			return parsed ? [parsed.prefix] : []
		}),
	)
	const overlaps = grouped.filter((group) => localPrefixes.has(group.prefix))
	const blockingOverlaps = overlaps.filter((group) =>
		mustYieldMigrationPrefix({
			group,
			currentPullNumber: input.currentPullNumber,
			isBaseBranchCheckout: input.isBaseBranchCheckout,
		}),
	)
	const keptOverlaps = overlaps.filter(
		(group) => !blockingOverlaps.includes(group),
	)
	const suggestedPrefix = suggestFreeMigrationPrefix({
		nextPrefix: input.localNextPrefix,
		claimedPrefixes,
		rank: renumberRank({
			blockingOverlaps,
			currentPullNumber: input.currentPullNumber,
		}),
	})
	if (suggestedPrefix === null) {
		return {
			suggestedPrefix: input.localNextPrefix,
			lines: [],
			warning:
				'No free 4-digit migration prefix remains. The ledger result is unchanged.',
			overlaps: [],
			blockingOverlaps: [],
		}
	}
	if (claims.length === 0) {
		return {
			suggestedPrefix,
			lines: [],
			warning: null,
			overlaps: [],
			blockingOverlaps: [],
		}
	}
	const lines = [
		`Open pull requests claim migration prefixes in ${input.migrationsDir}:`,
		...grouped.map((group) => `  ${group.prefix}: ${formatPullNumbers(group)}`),
	]
	if (blockingOverlaps.length > 0) {
		lines.push(
			'This checkout uses prefixes also claimed by open pull requests:',
			...blockingOverlaps.map(
				(group) => `  ${group.prefix}: ${formatPullNumbers(group)}`,
			),
			`Rename to the next free prefix ${suggestedPrefix} (for example, ${suggestedPrefix}-your-change.sql) before merging.`,
		)
		if (input.currentPullNumber !== null) {
			lines.push(
				`The lowest-numbered open pull request keeps a contested prefix, so #${String(input.currentPullNumber)} renumbers.`,
			)
		}
	}
	if (keptOverlaps.length > 0) {
		lines.push(
			input.isBaseBranchCheckout
				? 'This checkout already ships prefixes that open pull requests also claim; those pull requests must renumber:'
				: 'This checkout keeps contested prefixes (lowest open pull request number wins); these pull requests must renumber:',
			...keptOverlaps.map(
				(group) => `  ${group.prefix}: ${formatPullNumbers(group)}`,
			),
		)
	}
	if (suggestedPrefix !== input.localNextPrefix) {
		lines.push(
			`Next prefix free of this checkout and those claims: ${suggestedPrefix}.`,
		)
	}
	return { suggestedPrefix, lines, warning: null, overlaps, blockingOverlaps }
}

/**
 * Deterministic tie-break for a prefix both this checkout and other open pull
 * requests claim: the lowest pull request number keeps it. Base-branch
 * checkouts already shipped the prefix and never yield. Without a known pull
 * request number the checkout yields (conservative).
 */
export function mustYieldMigrationPrefix(input: {
	group: OpenPullRequestMigrationOverlap
	currentPullNumber: number | null
	isBaseBranchCheckout: boolean
}): boolean {
	if (input.isBaseBranchCheckout) return false
	const currentPullNumber = input.currentPullNumber
	if (currentPullNumber === null) return true
	return input.group.pullNumbers.some((number) => number < currentPullNumber)
}

/**
 * How many lower-numbered claimants outrank this checkout on its most
 * contested prefix. Rank N takes the N-th free prefix so several pull
 * requests renumbering away from one prefix land on distinct prefixes.
 */
function renumberRank(input: {
	blockingOverlaps: ReadonlyArray<OpenPullRequestMigrationOverlap>
	currentPullNumber: number | null
}): number {
	const currentPullNumber = input.currentPullNumber
	if (currentPullNumber === null) return 1
	let rank = 1
	for (const group of input.blockingOverlaps) {
		const lower = group.pullNumbers.filter(
			(number) => number < currentPullNumber,
		).length
		rank = Math.max(rank, lower)
	}
	return rank
}

function prefixesFromFileClaims(
	claims: ReadonlyArray<OpenPullRequestFileClaim>,
) {
	const parsed: Array<{ number: number; prefixes: Array<string> }> = []
	for (const claim of claims) {
		const prefixes = [
			...new Set(
				claim.filenames.flatMap((filename) => {
					const prefix = parseMigrationFilename(
						path.posix.basename(filename),
					)?.prefix
					return prefix ? [prefix] : []
				}),
			),
		].sort()
		if (prefixes.length === 0) continue
		parsed.push({ number: claim.number, prefixes })
	}
	return parsed
}

function groupClaimedPrefixes(
	claims: ReadonlyArray<{ number: number; prefixes: ReadonlyArray<string> }>,
) {
	const byPrefix = new Map<string, Set<number>>()
	for (const claim of claims) {
		for (const prefix of claim.prefixes) {
			const pullNumbers = byPrefix.get(prefix) ?? new Set<number>()
			pullNumbers.add(claim.number)
			byPrefix.set(prefix, pullNumbers)
		}
	}
	return [...byPrefix.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([prefix, pullNumbers]) => ({
			prefix,
			pullNumbers: [...pullNumbers].sort((left, right) => left - right),
		}))
}

function formatPullNumbers(group: { pullNumbers: ReadonlyArray<number> }) {
	return group.pullNumbers.map((number) => `#${String(number)}`).join(', ')
}

/**
 * Open-PR prefix overlaps fail only pull request checks (and local runs, which
 * have no GitHub event). Pushes to main and manual dispatches print the
 * advisory: the merged tree is still protected by the duplicate-prefix check,
 * and the pull request that must renumber fails its own check instead.
 */
export function shouldEnforceOpenPullRequestOverlaps(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const eventName = env.GITHUB_EVENT_NAME?.trim()
	if (!eventName) return true
	return isPullRequestEventName(eventName)
}

function isPullRequestEventName(eventName: string) {
	return eventName === 'pull_request' || eventName === 'pull_request_target'
}

function isBaseBranchCheckout(env: NodeJS.ProcessEnv) {
	const eventName = env.GITHUB_EVENT_NAME?.trim()
	return Boolean(eventName) && !isPullRequestEventName(eventName ?? '')
}

export async function main(
	migrationsDir: string = defaultMigrationsDir,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const result = await checkMigrationsDirectory(migrationsDir)
	const directoryEntries = await readdir(migrationsDir)
	const localFilenames = directoryEntries.filter((name) =>
		name.endsWith('.sql'),
	)
	const baseBranchCheckout = isBaseBranchCheckout(env)
	const currentPullNumber = baseBranchCheckout
		? null
		: resolveCurrentPullNumber(env, process.cwd())
	// Advisory only: missing GitHub auth or an API error must not fail the ledger check.
	const advisory = formatOpenPullRequestMigrationAdvisory({
		migrationsDir,
		localFilenames,
		trustedFilenames: result.trustedFilenames,
		localNextPrefix: result.nextPrefix,
		scan: await scanOpenPullRequestMigrationPrefixes({
			migrationsDir,
			env,
			currentPullNumber,
		}),
		currentPullNumber,
		isBaseBranchCheckout: baseBranchCheckout,
	})
	if (!result.ok) {
		console.error(
			`Migration filename check failed for ${migrationsDir} (${String(result.errors.length)} issue(s)):`,
		)
		for (const error of result.errors) {
			console.error(`  - ${error}`)
		}
		printMigrationPrefixAdvisory(advisory, console.error)
		process.exitCode = 1
		return
	}

	if (
		advisory.blockingOverlaps.length > 0 &&
		shouldEnforceOpenPullRequestOverlaps(env)
	) {
		console.error(
			`Migration prefix check failed for ${migrationsDir}: open pull requests claim the same prefix(es). Use ${advisory.suggestedPrefix}.`,
		)
		printMigrationPrefixAdvisory(advisory, console.error)
		process.exitCode = 1
		return
	}

	console.log(
		`Migration ledger ok: ${String(directoryEntries.length)} file(s) in ${migrationsDir} (next free prefix ${advisory.suggestedPrefix}).`,
	)
	printMigrationPrefixAdvisory(advisory, console.log)
}

function printMigrationPrefixAdvisory(
	advisory: OpenPullRequestMigrationAdvisory,
	write: (line: string) => void,
) {
	if (advisory.warning) console.warn(advisory.warning)
	for (const line of advisory.lines) write(line)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
