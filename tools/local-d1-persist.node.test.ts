import { expect, test } from 'vitest'
import { buildLocalMigrationCommands } from './apply-local-app-migrations.ts'
import { envWithWorkerPersistFile } from './local-d1-persist.ts'
import { buildSeedWranglerArgs, parseArgs } from './seed-test-data.ts'

function persistPathFromArgs(args: ReadonlyArray<string>) {
	const flagIndex = args.indexOf('--persist-to')
	const equalsForm = args.find((argument) =>
		argument.startsWith('--persist-to='),
	)
	if (equalsForm) return equalsForm.slice('--persist-to='.length)
	return flagIndex === -1 ? undefined : args[flagIndex + 1]
}

test('local migrate and seed target the persist directory Vite opens', () => {
	const commands = buildLocalMigrationCommands({ argv: [], env: {} })
	expect(commands).toHaveLength(7)
	const sharedPath = persistPathFromArgs(commands[2] ?? [])
	expect(sharedPath).toEqual(expect.any(String))
	for (const command of commands) {
		expect(persistPathFromArgs(command)).toBe(sharedPath)
	}
	expect(commands[0]?.[0]).toBe('tools/ci/reset-migration-bookkeeping.ts')
	expect(commands[0]).not.toContain('--env-file=packages/worker/.env')
	const bindings: Array<[string, string, Array<string>]> = [
		['APP_DB', 'packages/worker/migrations', []],
		['AUDIT_DB', 'packages/worker/audit-migrations', []],
		[
			'JOBS_DB',
			'packages/jobs-worker/migrations',
			['--config', 'packages/jobs-worker/wrangler.jsonc'],
		],
	]
	const checkStart = 1
	const applyStart = checkStart + bindings.length
	expect(
		commands
			.slice(checkStart, applyStart)
			.every(
				(command) => command[0] === 'tools/check-stale-local-migrations.ts',
			),
	).toBe(true)
	expect(
		commands.slice(applyStart).every((command) => command.includes('apply')),
	).toBe(true)
	for (const [index, [binding, migrationsDir, config]] of bindings.entries()) {
		const check = commands[checkStart + index]
		const apply = commands[applyStart + index]
		expect(check?.[0]).toBe('tools/check-stale-local-migrations.ts')
		expect(check).toEqual(
			expect.arrayContaining([
				'--binding',
				binding,
				'--migrations-dir',
				migrationsDir,
				...config,
			]),
		)
		expect(apply).toEqual(
			expect.arrayContaining([
				'--env-file=packages/worker/.env',
				'apply',
				binding,
				...config,
			]),
		)
	}

	const seedArgs = buildSeedWranglerArgs(
		parseArgs(['--local']),
		{ command: 'select 1' },
		{},
	)
	expect(persistPathFromArgs(seedArgs)).toBe(sharedPath)
	expect(seedArgs).toContain('--local')
	expect(seedArgs).not.toContain('--remote')
	expect(seedArgs).toContain('--command')
})

test('seed wrangler args prefer --file for large SQL payloads', () => {
	const fileArgs = buildSeedWranglerArgs(parseArgs(['--local']), {
		file: '/tmp/kody-seed.sql',
	})
	expect(fileArgs).toContain('--file')
	expect(fileArgs).toContain('/tmp/kody-seed.sql')
	expect(fileArgs).not.toContain('--command')
})

test('explicit persist-to wins over WRANGLER_PERSIST_TO, and remote seed skips it', () => {
	const env = { WRANGLER_PERSIST_TO: '.wrangler/state/from-env' }
	const fromEnv = buildLocalMigrationCommands({ argv: [], env })
	for (const command of fromEnv) {
		expect(persistPathFromArgs(command)).toBe('.wrangler/state/from-env')
	}

	const explicit = buildLocalMigrationCommands({
		argv: ['--persist-to', '.wrangler/state/e2e'],
		env,
	})
	for (const command of explicit) {
		expect(persistPathFromArgs(command)).toBe('.wrangler/state/e2e')
	}

	const equalsForm = buildLocalMigrationCommands({
		argv: ['--persist-to=.wrangler/state/custom'],
		env: {},
	})
	expect(persistPathFromArgs(equalsForm[1] ?? [])).toBe(
		'.wrangler/state/custom',
	)

	expect(() =>
		buildLocalMigrationCommands({ argv: ['--remote'], env: {} }),
	).toThrow(/Only --persist-to is allowed/)

	const remoteSeed = buildSeedWranglerArgs(
		parseArgs(['--remote', '--config', 'packages/worker/wrangler.jsonc']),
		{ command: 'select 1' },
		env,
	)
	expect(remoteSeed).toContain('--remote')
	expect(persistPathFromArgs(remoteSeed)).toBeUndefined()

	const explicitSeed = buildSeedWranglerArgs(
		parseArgs(['--local', '--persist-to', '.wrangler/state/e2e']),
		{ command: 'select 1' },
		env,
	)
	expect(persistPathFromArgs(explicitSeed)).toBe('.wrangler/state/e2e')
})

test('worker .env WRANGLER_PERSIST_TO reaches migrate and seed unless the shell or flag sets one', () => {
	const file = [
		'# local override',
		'COOKIE_SECRET=local',
		'export WRANGLER_PERSIST_TO=".wrangler/state/from-file"',
	].join('\n')
	const fromFile = envWithWorkerPersistFile({}, file)
	expect(fromFile.WRANGLER_PERSIST_TO).toBe('.wrangler/state/from-file')
	const migrated = buildLocalMigrationCommands({ argv: [], env: fromFile })
	for (const command of migrated) {
		expect(persistPathFromArgs(command)).toBe('.wrangler/state/from-file')
	}
	const seeded = buildSeedWranglerArgs(
		parseArgs(['--local']),
		{ command: 'select 1' },
		fromFile,
	)
	expect(persistPathFromArgs(seeded)).toBe('.wrangler/state/from-file')

	const shellWins = envWithWorkerPersistFile(
		{ WRANGLER_PERSIST_TO: '.wrangler/state/from-shell' },
		file,
	)
	expect(
		persistPathFromArgs(
			buildLocalMigrationCommands({ argv: [], env: shellWins })[1] ?? [],
		),
	).toBe('.wrangler/state/from-shell')

	const flagged = buildLocalMigrationCommands({
		argv: ['--persist-to', '.wrangler/state/e2e'],
		env: fromFile,
	})
	expect(persistPathFromArgs(flagged[1] ?? [])).toBe('.wrangler/state/e2e')

	expect(envWithWorkerPersistFile({}, 'WRANGLER_PERSIST_TO=')).toEqual({})
	expect(envWithWorkerPersistFile({}, undefined)).toEqual({})
})
