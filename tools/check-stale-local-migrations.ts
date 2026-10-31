/**
 * Local-only guard that runs before each `wrangler d1 migrations apply --local`
 * in tools/apply-local-app-migrations.ts.
 *
 * Wrangler records applied migrations by filename. Renaming a migration that a
 * persisted local state dir already applied (for example taking the next free
 * prefix after a parallel PR landed the same one) leaves the old name in
 * `d1_migrations`, and the next apply re-runs the same SQL under the new name
 * and fails with an error such as `duplicate column name`. This check fails
 * first, naming every recorded migration that is no longer on disk and the
 * reset step. Disposable e2e persist (`.wrangler/state/e2e`) is reset
 * automatically because every e2e run reseeds it. apply-local-app-migrations
 * runs every binding's stale check before any apply, so a later binding
 * cannot wipe a database that already migrated. Dev persist may hold
 * unreleased SQL that git cannot recover, so it never rewrites bookkeeping;
 * PR previews heal through tools/ci/rewrite-renamed-preview-migrations.ts
 * instead.
 */

import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'
import { executeWranglerD1 } from './wrangler-d1-execute.ts'

/**
 * Playwright / `migrate:e2e` persist dir. It is reseeded every run, so a
 * renamed migration can reset it instead of failing the e2e web server.
 * Dev persist (`.wrangler/state`, including Wrangler's `v3` subtree) stays
 * fail-closed because it can hold unreleased local data.
 */
export const disposableE2ePersistPath = '.wrangler/state/e2e'

export function isDisposableLocalPersistPath(persistTo: string) {
	const normalized = persistTo.replaceAll('\\', '/').replace(/\/+$/, '')
	return (
		normalized === disposableE2ePersistPath ||
		normalized.endsWith(`/${disposableE2ePersistPath}`)
	)
}

export function resolveStaleLocalMigrationsAction(input: {
	persistTo: string
	stale: ReadonlyArray<string>
}): 'ok' | 'reset-disposable' | 'fail' {
	if (input.stale.length === 0) return 'ok'
	return isDisposableLocalPersistPath(input.persistTo)
		? 'reset-disposable'
		: 'fail'
}

export function findStaleAppliedMigrations(input: {
	appliedNames: ReadonlyArray<string>
	onDiskNames: ReadonlyArray<string>
}) {
	const onDisk = new Set(input.onDiskNames)
	return input.appliedNames.filter((name) => !onDisk.has(name)).sort()
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

export function formatStaleLocalMigrationsError(input: {
	binding: string
	migrationsDir: string
	persistTo: string
	stale: ReadonlyArray<string>
}) {
	return [
		`Local ${input.binding} state in ${input.persistTo} records migrations that no longer exist in ${input.migrationsDir}:`,
		...input.stale.map((name) => `  ${name}`),
		'A renamed or deleted migration keeps its old name in d1_migrations, so applying would run the same SQL again under the new name.',
		'Reset the local state (this deletes all local data in that directory), then rerun the same command:',
		`  rm -rf -- ${shellQuote(input.persistTo)}`,
	].join('\n')
}

export function formatDisposableStaleLocalMigrationsReset(input: {
	binding: string
	persistTo: string
	stale: ReadonlyArray<string>
}) {
	return [
		`Local ${input.binding} state in ${input.persistTo} records migrations that no longer exist:`,
		...input.stale.map((name) => `  ${name}`),
		'This persist directory is disposable e2e state and is reseeded on every run, so it was reset automatically.',
	].join('\n')
}

type CliOptions = {
	binding: string
	migrationsDir: string
	persistTo: string
	config: string | null
}

const valueFlags: Record<string, keyof CliOptions> = {
	'--binding': 'binding',
	'--migrations-dir': 'migrationsDir',
	'--persist-to': 'persistTo',
	'--config': 'config',
}

export function parseArgs(argv: ReadonlyArray<string>): CliOptions {
	const options: CliOptions = {
		binding: '',
		migrationsDir: '',
		persistTo: '',
		config: null,
	}
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!
		if (argument.startsWith('--persist-to=')) {
			options.persistTo = argument.slice('--persist-to='.length)
			continue
		}
		const key = valueFlags[argument]
		if (!key) {
			throw new Error(
				`Unsupported argument: ${argument}. Supported: --binding <name>, --migrations-dir <path>, --persist-to <path>, --config <path>.`,
			)
		}
		const value = argv[index + 1]
		if (!value) throw new Error(`${argument} requires a value`)
		options[key] = value
		index += 1
	}
	for (const [flag, value] of [
		['--binding', options.binding],
		['--migrations-dir', options.migrationsDir],
		['--persist-to', options.persistTo],
	] as const) {
		if (!value) throw new Error(`${flag} is required`)
	}
	return options
}

function queryNames(options: CliOptions, sql: string): Array<string> {
	const rows = executeWranglerD1({
		binding: options.binding,
		sql,
		mode: '--local',
		persistTo: options.persistTo,
		...(options.config ? { config: options.config } : {}),
	})
	return rows.map((row) => String(row.name))
}

function queryAppliedMigrationNames(options: CliOptions) {
	const tables = queryNames(
		options,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';",
	)
	if (tables.length === 0) return []
	return queryNames(options, 'SELECT name FROM d1_migrations ORDER BY name;')
}

function listMigrationNames(migrationsDir: string) {
	return readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))
}

export function main(argv: ReadonlyArray<string>) {
	const options = parseArgs(argv)
	const stale = findStaleAppliedMigrations({
		appliedNames: queryAppliedMigrationNames(options),
		onDiskNames: listMigrationNames(path.resolve(options.migrationsDir)),
	})
	const action = resolveStaleLocalMigrationsAction({
		persistTo: options.persistTo,
		stale,
	})
	switch (action) {
		case 'ok':
			return 0
		case 'reset-disposable':
			console.error(
				formatDisposableStaleLocalMigrationsReset({
					binding: options.binding,
					persistTo: options.persistTo,
					stale,
				}),
			)
			rmSync(options.persistTo, { recursive: true, force: true })
			return 0
		case 'fail':
			console.error(
				formatStaleLocalMigrationsError({
					binding: options.binding,
					migrationsDir: options.migrationsDir,
					persistTo: options.persistTo,
					stale,
				}),
			)
			return 1
		default: {
			const never: never = action
			throw new Error(`Unhandled stale local migrations action: ${never}`)
		}
	}
}

if (isExecutedDirectly(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2))
}
