import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	checkMigrationFilenameReferences,
	checkMigrationFilenames,
	checkMigrationLedger,
	checkMigrationsDirectory,
	checkRepositoryMigrationFilenameReferences,
	collectMigrationFilenameReferences,
	expectedMigrationBaselineSha256,
	formatMigrationPrefix,
	formatOpenPullRequestMigrationAdvisory,
	getMaxMigrationPrefix,
	getNextMigrationPrefix,
	hashMigrationContent,
	isPlaceholderMigrationFilename,
	parseMigrationFilename,
	readMigrationLedger,
	suggestFreeMigrationPrefix,
	resolveTrustedMigrationBase,
	type MigrationLedger,
	type MigrationLedgerEntry,
	type TrustedMigrationHistory,
} from './check-migrations.ts'

function withoutInheritedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([key]) => !key.startsWith('GIT_')),
	)
}

const uniqueMigrations = [
	'0001-init.sql',
	'0002-chat-threads.sql',
	'0075-stable-user-id-not-null.sql',
	'0077-drop-email-raw-mime-inline.sql',
] as const

function expectErrorsMention(
	errors: ReadonlyArray<string>,
	needles: ReadonlyArray<string>,
) {
	expect(
		needles.filter((needle) => !errors.some((error) => error.includes(needle))),
	).toEqual([])
}

// Runs the live checkMigrationsDirectory() path (git subprocess per migration
// file), which can exceed the default test timeout on loaded local machines.
test(
	'migration filename helpers parse, score prefixes, and accept unique plus grandfathered pairs',
	{ timeout: 30_000 },
	async () => {
		const parseCases: Array<
			[string, ReturnType<typeof parseMigrationFilename>]
		> = [
			['0001-init.sql', { prefix: '0001', description: 'init' }],
			[
				'0075-stable-user-id-not-null.sql',
				{ prefix: '0075', description: 'stable-user-id-not-null' },
			],
			...[
				'1-init.sql',
				'0001_init.sql',
				'0001-Init.sql',
				'0001-init-.sql',
				'0001-.sql',
				'0001-init.SQL',
				'readme.md',
				'0001-init.sql.bak',
			].map((filename): [string, null] => [filename, null]),
		]
		expect(
			parseCases.map(([filename]) => [
				filename,
				parseMigrationFilename(filename),
			]),
		).toEqual(parseCases)

		const filenamesWithGap = [
			'0001-init.sql',
			'0038-backfill-usernames.sql',
			// Gap at 0039 is intentional and must not be treated as an error.
			'0040-drop-source-rescue-events.sql',
			'0075-stable-user-id-not-null.sql',
		]
		expect(getMaxMigrationPrefix(filenamesWithGap)).toBe(75)
		expect(getNextMigrationPrefix(filenamesWithGap)).toBe('0076')
		expect(formatMigrationPrefix(76)).toBe('0076')
		expect(formatMigrationPrefix(1)).toBe('0001')
		expect(getNextMigrationPrefix([])).toBe('0001')
		expect(
			getNextMigrationPrefix([...filenamesWithGap, '9999-BadName.sql']),
		).toBe('0076')

		expect(checkMigrationFilenames(filenamesWithGap)).toMatchObject({
			ok: true,
			errors: [],
			nextPrefix: '0076',
		})
		expect(checkMigrationFilenames([...uniqueMigrations])).toMatchObject({
			ok: true,
			errors: [],
			nextPrefix: '0078',
			maxPrefix: 77,
		})

		const live = await checkMigrationsDirectory()
		expect(live.ok).toBe(true)
		expect(live.errors).toEqual([])
		expect(live.nextPrefix).toBe(formatMigrationPrefix(live.maxPrefix + 1))
		expect(live.nextPrefix).toMatch(/^\d{4}$/)
	},
)

test('migration ledger rejects historical mutation and lower-prefix additions while accepting monotonic additions', async () => {
	const ledger = await readMigrationLedger()
	const baselineFiles = ledger.migrations.map((entry) => ({ ...entry }))
	const trustedHistory: TrustedMigrationHistory = {
		ref: 'trusted-base',
		files: baselineFiles,
		ledgerEntries: baselineFiles,
		ledgerBaselineSha256: expectedMigrationBaselineSha256,
	}
	const squashed = '0001-squashed-init.sql'
	const withSquashed = (patch: Partial<MigrationLedgerEntry> | null) =>
		checkMigrationLedger(
			baselineFiles.flatMap((entry) =>
				entry.filename !== squashed
					? [entry]
					: patch
						? [{ ...entry, ...patch }]
						: [],
			),
			ledger,
			trustedHistory,
		)
	const withAddition = (addition: MigrationLedgerEntry) => {
		const nextLedger = structuredClone(ledger)
		nextLedger.migrations.push(addition)
		return checkMigrationLedger(
			[...baselineFiles, addition],
			nextLedger,
			trustedHistory,
		)
	}

	const baseline = checkMigrationLedger(baselineFiles, ledger, trustedHistory)
	expect(baseline).toMatchObject({ ok: true, errors: [] })
	expect(baseline.nextPrefix).toBe(
		formatMigrationPrefix(baseline.maxPrefix + 1),
	)

	const rejections: Array<
		[ReturnType<typeof checkMigrationLedger>, Array<string>]
	> = [
		[withSquashed({ sha256: '0'.repeat(64) }), [squashed, 'modified']],
		[withSquashed(null), [squashed, 'missing', 'cannot be deleted or renamed']],
		[
			withSquashed({ filename: '0001-renamed.sql' }),
			[
				squashed,
				'missing',
				'0001-renamed.sql',
				'not in tools/migration-ledger.json',
			],
		],
		[
			withAddition({ filename: '0001-too-low.sql', sha256: '1'.repeat(64) }),
			['0001-too-low.sql', 'at or below frozen baseline maximum 0001'],
		],
	]
	for (const [result, mentions] of rejections) {
		expect(result.ok).toBe(false)
		expectErrorsMention(result.errors, mentions)
	}

	expect(
		withAddition({
			filename: `${baseline.nextPrefix}-normal-addition.sql`,
			sha256: '2'.repeat(64),
		}),
	).toMatchObject({
		ok: true,
		errors: [],
		nextPrefix: formatMigrationPrefix(baseline.maxPrefix + 2),
		maxPrefix: baseline.maxPrefix + 1,
	})
})

test('trusted history rejects a migration and ledger digest co-edit', async () => {
	const ledger = await readMigrationLedger()
	const bootstrapFiles = ledger.migrations.map((entry) => ({ ...entry }))
	const historicalEntry = {
		filename: '0095-historical.sql',
		sha256: hashMigrationContent('SELECT 1;\n'),
	}
	const trustedHistory: TrustedMigrationHistory = {
		ref: 'trusted-base-with-0095',
		files: [...bootstrapFiles, historicalEntry],
		ledgerEntries: [...bootstrapFiles, historicalEntry],
		ledgerBaselineSha256: expectedMigrationBaselineSha256,
	}
	const editedEntry = {
		...historicalEntry,
		sha256: hashMigrationContent('SELECT 2;\n'),
	}
	const editedLedger = structuredClone(ledger)
	editedLedger.migrations.push(editedEntry)

	const result = checkMigrationLedger(
		[...bootstrapFiles, editedEntry],
		editedLedger,
		trustedHistory,
	)
	expect(result.ok).toBe(false)
	expectErrorsMention(result.errors, [
		'0095-historical.sql',
		'Historical ledger entries cannot be edited',
		'differs from trusted history',
		'Migration and ledger digests cannot be changed together',
	])

	const withoutTrustedBase = checkMigrationLedger(
		[...bootstrapFiles, editedEntry],
		editedLedger,
	)
	expect(withoutTrustedBase.ok).toBe(false)
	expectErrorsMention(withoutTrustedBase.errors, [
		'no trusted Git base is available',
		'Fetch origin/main history',
	])
})

test('trusted history allows a listed migration-repairs digest rewrite', async () => {
	const ledger = await readMigrationLedger()
	const bootstrapFiles = ledger.migrations.map((entry) => ({ ...entry }))
	const historicalEntry = {
		filename: '0199-repairable.sql',
		sha256: hashMigrationContent('SELECT 1;\n'),
	}
	const trustedHistory: TrustedMigrationHistory = {
		ref: 'trusted-base-with-0199',
		files: [...bootstrapFiles, historicalEntry],
		ledgerEntries: [...bootstrapFiles, historicalEntry],
		ledgerBaselineSha256: expectedMigrationBaselineSha256,
	}
	const repairedEntry = {
		...historicalEntry,
		sha256: hashMigrationContent('SELECT 2;\n'),
	}
	const repairedLedger = structuredClone(ledger)
	repairedLedger.migrations.push(repairedEntry)

	const withoutRepair = checkMigrationLedger(
		[...bootstrapFiles, repairedEntry],
		repairedLedger,
		trustedHistory,
	)
	expect(withoutRepair.ok).toBe(false)

	const withRepair = checkMigrationLedger(
		[...bootstrapFiles, repairedEntry],
		repairedLedger,
		trustedHistory,
		[
			{
				filename: historicalEntry.filename,
				fromSha256: historicalEntry.sha256,
				toSha256: repairedEntry.sha256,
				reason: 'rolled back before d1_migrations recorded the file',
			},
		],
	)
	expect(withRepair.ok).toBe(true)

	const wrongDestination = checkMigrationLedger(
		[...bootstrapFiles, repairedEntry],
		repairedLedger,
		trustedHistory,
		[
			{
				filename: historicalEntry.filename,
				fromSha256: historicalEntry.sha256,
				toSha256: hashMigrationContent('SELECT 3;\n'),
				reason: 'rolled back before d1_migrations recorded the file',
			},
		],
	)
	expect(wrongDestination.ok).toBe(false)
})

test('migration content hashing canonicalizes CRLF to LF', () => {
	expect(hashMigrationContent('CREATE TABLE example (id TEXT);\r\n')).toBe(
		hashMigrationContent('CREATE TABLE example (id TEXT);\n'),
	)
	expect(hashMigrationContent('line one\r\nline two\r\n')).toBe(
		hashMigrationContent('line one\nline two\n'),
	)
})

test('trusted migration base resolves the PR base, push before, merge base, or first parent without accepting HEAD', async () => {
	const head = { 'rev-parse HEAD^{commit}': 'head' }
	const onMain = {
		...head,
		'merge-base HEAD origin/main': 'head',
		'merge-base HEAD main': 'head',
	}
	const cases: Array<{
		name: string
		env: NodeJS.ProcessEnv
		responses: Record<string, string | null>
		expected: string | null
	}> = [
		{
			name: 'pull request base SHA',
			env: { MIGRATION_VALIDATION_BASE: 'pr-base', GITHUB_BASE_REF: 'main' },
			responses: { ...head, 'rev-parse pr-base^{commit}': 'pr-base-sha' },
			expected: 'pr-base-sha',
		},
		{
			name: 'main push before SHA',
			env: { MIGRATION_VALIDATION_BASE: 'push-before' },
			responses: { ...head, 'rev-parse push-before^{commit}': 'before-sha' },
			expected: 'before-sha',
		},
		{
			name: 'local feature branch merge base',
			env: {},
			responses: { ...head, 'merge-base HEAD origin/main': 'branch-base' },
			expected: 'branch-base',
		},
		{
			name: 'main or detached checkout first parent',
			env: {},
			responses: { ...onMain, 'rev-parse HEAD^1': 'parent-sha' },
			expected: 'parent-sha',
		},
		{
			name: 'depth-one detached cloud checkout',
			env: {},
			responses: { ...onMain, 'rev-parse HEAD^1': null },
			expected: null,
		},
	]
	const resolved = []
	for (const { name, env, responses } of cases) {
		resolved.push({
			name,
			expected: await resolveTrustedMigrationBase({
				env,
				git: async (args) => responses[args.join(' ')] ?? null,
			}),
		})
	}
	expect(resolved).toEqual(
		cases.map(({ name, expected }) => ({ name, expected })),
	)
})

// Bootstraps a real temp git repo and spawns the checker script, which can
// exceed the default test timeout on loaded local machines.
test(
	'runtime main validation rejects a historical migration and ledger co-edit',
	{ timeout: 30_000 },
	async () => {
		const tempRoot = await mkdtemp(
			path.join(os.tmpdir(), 'kody-migration-main-'),
		)
		const checkerPath = fileURLToPath(
			new URL('./check-migrations.ts', import.meta.url),
		)
		// Husky exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into hook
		// processes. Without stripping them, `git init` and `git add` here
		// would target the real repository instead of the scratch one.
		const scratchGitEnv = withoutInheritedGitEnv(process.env)
		const runGit = (...args: Array<string>) =>
			execFileSync('git', args, {
				cwd: tempRoot,
				encoding: 'utf8',
				stdio: 'pipe',
				env: scratchGitEnv,
			})
		const migrationPath = path.join(
			tempRoot,
			'packages/worker/migrations/0091-future.sql',
		)
		const ledgerPath = path.join(tempRoot, 'tools/migration-ledger.json')
		const commitMigration = async (
			ledger: MigrationLedger,
			sql: string,
			message: string,
		) => {
			await writeFile(migrationPath, sql)
			ledger.migrations = [
				...ledger.migrations.filter(
					(entry) => entry.filename !== '0091-future.sql',
				),
				{ filename: '0091-future.sql', sha256: hashMigrationContent(sql) },
			]
			await writeFile(ledgerPath, `${JSON.stringify(ledger, null, '\t')}\n`)
			runGit('add', '.')
			runGit('commit', '-m', message)
		}

		try {
			await cp(
				'packages/worker/migrations',
				path.join(tempRoot, 'packages/worker/migrations'),
				{ recursive: true },
			)
			await cp('tools/migration-ledger.json', ledgerPath)
			runGit('init', '-b', 'main')
			runGit('config', 'user.name', 'Migration Test')
			runGit('config', 'user.email', 'migration-test@example.com')
			runGit('add', '.')
			runGit('commit', '-m', 'bootstrap')

			const ledger = JSON.parse(
				await readFile(ledgerPath, 'utf8'),
			) as MigrationLedger
			await commitMigration(ledger, 'SELECT 1;\n', 'land migration')
			await commitMigration(
				ledger,
				'SELECT 2;\n',
				'co-edit migration and ledger',
			)

			const result = spawnSync(process.execPath, [checkerPath], {
				cwd: tempRoot,
				encoding: 'utf8',
				env: {
					...scratchGitEnv,
					GITHUB_BASE_REF: '',
					GITHUB_REF_NAME: 'main',
					MIGRATION_VALIDATION_BASE: '',
					GH_TOKEN: '',
					GITHUB_TOKEN: '',
					GITHUB_REPOSITORY: '',
				},
			})
			expect(result.status).toBe(1)
			expect(result.stderr).toContain('0091-future.sql')
			expect(result.stderr).toContain(
				'Historical ledger entries cannot be edited',
			)
			expect(result.stderr).toContain('differs from trusted history')
			expect(result.stderr).not.toContain('prefix scan')
		} finally {
			await rm(tempRoot, { recursive: true, force: true })
		}
	},
)

test('migrations:check flags docs and source references to missing migration filenames', () => {
	expect(
		isPlaceholderMigrationFilename('0074-platform-oauth-app-visibility.sql'),
	).toBe(false)
	expect(
		collectMigrationFilenameReferences(
			'See 0075-platform-oauth-app-visibility.sql and 0075-platform-oauth-app-visibility.sql again.',
		),
	).toEqual(['0075-platform-oauth-app-visibility.sql'])

	const knownFilenames = new Set([
		'0001-squashed-init.sql',
		'0075-platform-oauth-app-visibility.sql',
		'0001-jobs-init.sql',
		'0001-audit-events.sql',
	])
	expect(
		checkMigrationFilenameReferences({
			knownFilenames,
			files: [
				{
					path: 'docs/contributing/setup/migrations.md',
					content:
						'Use the next free prefix (for example, 0076-my-change.sql).',
				},
				{
					path: 'docs/contributing/architecture/integrations.md',
					content:
						'Visibility lives in 0075-platform-oauth-app-visibility.sql.',
				},
				{
					path: 'docs/contributing/architecture/data-storage.md',
					content:
						'Jobs schema is packages/jobs-worker/migrations/0001-jobs-init.sql.',
				},
			],
		}),
	).toEqual([])
	expect(
		checkMigrationFilenameReferences({
			knownFilenames,
			files: [
				{
					path: 'docs/contributing/decisions/0002-data-placement.md',
					content:
						'RunLog dropped D1 rows in 0112-drop-package-invocations.sql.',
				},
				{
					path: 'docs/contributing/architecture/integrations.md',
					content:
						'Visibility lives in 0074-platform-oauth-app-visibility.sql.',
				},
				{
					path: 'packages/worker/src/integrations/platform-apps.node.test.ts',
					content:
						"const visibilityMigration = '0074-platform-oauth-app-visibility.sql'",
				},
				{
					path: 'packages/worker/src/app/note.tsx',
					content:
						"const visibilityMigration = '0074-platform-oauth-app-visibility.sql'",
				},
			],
		}),
	).toEqual([
		'docs/contributing/architecture/integrations.md references migration "0074-platform-oauth-app-visibility.sql", which is not in packages/worker/migrations (or jobs/audit migration directories). After a renumber, update the reference to the current filename.',
		'packages/worker/src/integrations/platform-apps.node.test.ts references migration "0074-platform-oauth-app-visibility.sql", which is not in packages/worker/migrations (or jobs/audit migration directories). After a renumber, update the reference to the current filename.',
		'packages/worker/src/app/note.tsx references migration "0074-platform-oauth-app-visibility.sql", which is not in packages/worker/migrations (or jobs/audit migration directories). After a renumber, update the reference to the current filename.',
	])
})

test('migrations:check walks tsx files when scanning the repository', async () => {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'migration-tsx-refs-'))
	const srcDir = path.join(tempRoot, 'packages', 'worker', 'src')
	const migrationsDir = path.join(tempRoot, 'packages', 'worker', 'migrations')
	try {
		await mkdir(srcDir, { recursive: true })
		await mkdir(migrationsDir, { recursive: true })
		await writeFile(path.join(migrationsDir, '0001-squashed-init.sql'), '--\n')
		await writeFile(
			path.join(srcDir, 'note.tsx'),
			"const visibilityMigration = '0074-platform-oauth-app-visibility.sql'\n",
		)
		const errors = await checkRepositoryMigrationFilenameReferences(tempRoot)
		expect(
			errors.filter((error) => error.includes('packages/worker/src/note.tsx')),
		).toEqual([
			'packages/worker/src/note.tsx references migration "0074-platform-oauth-app-visibility.sql", which is not in packages/worker/migrations (or jobs/audit migration directories). After a renumber, update the reference to the current filename.',
		])
	} finally {
		await rm(tempRoot, { recursive: true, force: true })
	}
})

test('checkMigrationFilenames rejects malformed names, ordinary duplicates, and non-allowlisted prefix reuse', () => {
	const cases = [
		{
			filenames: ['0002-BadName.sql', 'notes.txt'],
			errorCount: 2,
			mentions: ['0002-BadName.sql', 'notes.txt'],
		},
		{
			filenames: [
				'0024-repo-sessions-and-source-columns.sql',
				'0024-extra-change.sql',
			],
			errorCount: 1,
			mentions: [
				'0024',
				'0024-extra-change.sql',
				'0024-repo-sessions-and-source-columns.sql',
			],
		},
		// The 2026-08-04 migration squash retired the grandfathered pairs, so a
		// formerly allowlisted pair is rejected like any other duplicate prefix.
		{
			filenames: [
				'0009-secret-allowed-hosts.sql',
				'0009-ui-artifact-parameters.sql',
			],
			errorCount: 1,
			mentions: [
				'0009',
				'0009-secret-allowed-hosts.sql',
				'0009-ui-artifact-parameters.sql',
			],
		},
	]
	for (const { filenames, errorCount, mentions } of cases) {
		const result = checkMigrationFilenames([
			'0001-init.sql',
			...filenames,
			'0075-stable-user-id-not-null.sql',
		])
		expect(result).toMatchObject({ ok: false, nextPrefix: '0076' })
		expect(result.errors).toHaveLength(errorCount)
		expectErrorsMention(result.errors, mentions)
		expect(result.errors.join('\n')).not.toMatch(/grandfathered/i)
	}
})

test('the next free prefix skips open-PR claims and still allows gaps', () => {
	expect(
		suggestFreeMigrationPrefix({
			nextPrefix: '0098',
			claimedPrefixes: [],
		}),
	).toBe('0098')
	expect(
		suggestFreeMigrationPrefix({
			nextPrefix: '0098',
			claimedPrefixes: ['0097', '0098', '0100', 'not-a-prefix'],
		}),
	).toBe('0099')
	expect(
		suggestFreeMigrationPrefix({ nextPrefix: '98', claimedPrefixes: [] }),
	).toBeNull()
	expect(
		suggestFreeMigrationPrefix({
			nextPrefix: '9999',
			claimedPrefixes: ['9999'],
		}),
	).toBeNull()
	expect(
		formatOpenPullRequestMigrationAdvisory({
			migrationsDir: 'packages/worker/migrations',
			localFilenames: ['9999-final.sql'],
			localNextPrefix: '10000',
			scan: { status: 'ok', claims: [] },
		}),
	).toEqual({
		suggestedPrefix: '10000',
		lines: [],
		warning:
			'No free 4-digit migration prefix remains. The ledger result is unchanged.',
		overlaps: [],
	})

	const migrationsDir = 'packages/worker/migrations'
	const localFilenames = ['0001-squashed-init.sql', '0097-already.sql']
	expect(
		formatOpenPullRequestMigrationAdvisory({
			migrationsDir,
			localFilenames,
			localNextPrefix: '0098',
			scan: { status: 'skipped', reason: 'no-token' },
		}),
	).toEqual({
		suggestedPrefix: '0098',
		lines: [],
		warning: null,
		overlaps: [],
	})
	expect(
		formatOpenPullRequestMigrationAdvisory({
			migrationsDir,
			localFilenames,
			localNextPrefix: '0098',
			scan: { status: 'skipped', reason: 'no-repository' },
		}).warning,
	).toBeNull()

	const unauthorized = formatOpenPullRequestMigrationAdvisory({
		migrationsDir,
		localFilenames,
		localNextPrefix: '0098',
		scan: {
			status: 'skipped',
			reason: 'unauthorized',
			detail: 'GitHub API GET /repos/kody-hq/kody/pulls failed (401)',
		},
	})
	expect(unauthorized.suggestedPrefix).toBe('0098')
	expect(unauthorized.lines).toEqual([])
	expect(unauthorized.overlaps).toEqual([])
	expect(unauthorized.warning).toContain('failed (401)')

	const claimed = formatOpenPullRequestMigrationAdvisory({
		migrationsDir,
		localFilenames,
		localNextPrefix: '0098',
		scan: {
			status: 'ok',
			claims: [
				{
					number: 3220,
					filenames: [
						`${migrationsDir}/0098-usage.sql`,
						`${migrationsDir}/0097-Bad.sql`,
					],
				},
				{
					number: 3219,
					filenames: [`${migrationsDir}/0097-contract.sql`],
				},
				{
					number: 3242,
					filenames: [`${migrationsDir}/0097-oauth.sql`],
				},
				{
					number: 3238,
					filenames: [`${migrationsDir}/0100-daily.sql`],
				},
			],
		},
	})
	expect(claimed.warning).toBeNull()
	expect(claimed.suggestedPrefix).toBe('0099')
	expect(claimed.overlaps).toEqual([
		{ prefix: '0097', pullNumbers: [3219, 3242] },
	])
	expect(claimed.lines).toEqual([
		`Open pull requests claim migration prefixes in ${migrationsDir}:`,
		'  0097: #3219, #3242',
		'  0098: #3220',
		'  0100: #3238',
		'This checkout uses prefixes also claimed by open pull requests:',
		'  0097: #3219, #3242',
		'Rename to the next free prefix 0099 (for example, 0099-your-change.sql) before merging.',
		'Next prefix free of this checkout and those claims: 0099.',
	])
})

test('open PR claims cannot require renaming shipped migrations but still block new collisions', () => {
	const migrationsDir = 'packages/worker/migrations'
	const scan = {
		status: 'ok' as const,
		claims: [
			{
				number: 3768,
				filenames: [
					`${migrationsDir}/0142-other.sql`,
					`${migrationsDir}/0143-other.sql`,
				],
			},
		],
	}
	const input = {
		migrationsDir,
		localFilenames: ['0142-users-personal-org-id.sql', '0143-new-change.sql'],
		trustedFilenames: ['0142-users-personal-org-id.sql'],
		localNextPrefix: '0144',
		scan,
	}
	const result = formatOpenPullRequestMigrationAdvisory(input)
	expect(result.overlaps).toEqual([{ prefix: '0143', pullNumbers: [3768] }])
	expect(
		formatOpenPullRequestMigrationAdvisory({
			...input,
			localFilenames: input.trustedFilenames,
		}).overlaps,
	).toEqual([])
	// Only exact trusted filenames qualify, never every file with a shipped prefix.
	expect(
		formatOpenPullRequestMigrationAdvisory({
			...input,
			localFilenames: ['0142-different-new-file.sql'],
		}).overlaps,
	).toEqual([{ prefix: '0142', pullNumbers: [3768] }])
	// Without trusted history the check remains conservative.
	expect(
		formatOpenPullRequestMigrationAdvisory({
			...input,
			trustedFilenames: undefined,
		}).overlaps,
	).toHaveLength(2)
})
