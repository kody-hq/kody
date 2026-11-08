import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
	formatMigrationPrefix,
	getMaxMigrationPrefix,
	parseMigrationFilename,
} from './check-migrations.ts'
import { isExecutedDirectly } from './node-runtime.ts'

const migrationsPath = 'packages/worker/migrations'

/**
 * Migrations a branch adds whose prefix is not above the base tip's maximum.
 * PR CI compares against the merge base, so a migration that merges after a
 * higher prefix lands on main passes CI and then fails main Validate (#4812).
 */
export function findStaleMigrationPrefixes(input: {
	added: ReadonlyArray<string>
	baseFilenames: ReadonlyArray<string>
}) {
	const baseMaximumPrefix = getMaxMigrationPrefix(input.baseFilenames)
	const onBase = new Set(input.baseFilenames)
	const stale = input.added.filter((filename) => {
		if (onBase.has(filename)) return false
		const parsed = parseMigrationFilename(filename)
		return parsed !== null && Number(parsed.prefix) <= baseMaximumPrefix
	})
	return { baseMaximumPrefix, stale }
}

function git(args: ReadonlyArray<string>) {
	const result = spawnSync('git', args, { encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
	}
	return result.stdout
}

function sqlBasenames(output: string) {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.endsWith('.sql'))
		.map((line) => path.posix.basename(line))
}

function main(baseRef = 'origin/main') {
	const mergeBase = git(['merge-base', 'HEAD', baseRef]).trim()
	const added = sqlBasenames(
		git([
			'diff',
			'--name-only',
			'--diff-filter=A',
			mergeBase,
			'HEAD',
			'--',
			`${migrationsPath}/`,
		]),
	)
	const baseFilenames = sqlBasenames(
		git(['ls-tree', '--name-only', baseRef, `${migrationsPath}/`]),
	)
	const { baseMaximumPrefix, stale } = findStaleMigrationPrefixes({
		added,
		baseFilenames,
	})
	if (stale.length === 0) {
		console.log(
			`Migration prefixes ok against ${baseRef} (${String(added.length)} added, base maximum ${formatMigrationPrefix(baseMaximumPrefix)}).`,
		)
		return 0
	}
	console.error(
		`${baseRef} already has prefix ${formatMigrationPrefix(baseMaximumPrefix)}. Rename these migrations (and their tools/migration-ledger entries) starting at ${formatMigrationPrefix(baseMaximumPrefix + 1)} before merging:`,
	)
	for (const filename of stale) console.error(`  - ${filename}`)
	return 1
}

if (isExecutedDirectly(import.meta.url)) {
	process.exitCode = main(process.argv[2])
}
