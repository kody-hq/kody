/**
 * Every write to a table that feeds roles or the org binding must bump
 * `orgs.access_epoch` in the same D1 batch (access-compile.ts,
 * mcp-auth-cache.ts). This scan keeps a new write path from skipping the
 * bump silently: a file that writes one of those tables must be listed here
 * with how it invalidates, and the runtime guard
 * (test-support/access-epoch-write-guard.ts) covers the batch shape.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	accessEpochGuardedTables,
	accessTableWrittenBy,
	bumpsAccessEpoch,
} from '#worker/test-support/access-epoch-write-guard.ts'

const workerSrc = fileURLToPath(new URL('../', import.meta.url))

type Invalidation =
	/** Writers batch `bumpAccessEpochStatement` (or an inline bump) with the write. */
	| 'same-batch-bump'
	/**
	 * The `orgs` row is created or deleted in the same batch: no cached decision
	 * for that org id can exist, or the live-row epoch read misses.
	 */
	| 'org-row-lifecycle'
	/**
	 * Org soft-delete tombstones the `orgs` row before sweeping rows; the epoch
	 * read filters live orgs, so every entry misses until restore bumps.
	 */
	| 'org-tombstone-then-restore-bump'
	/** Person hard purge runs after the `users` row is gone: identity fails closed. */
	| 'person-row-gone'

const writers: Record<string, Invalidation> = {
	'admin/personal-org-repair.ts': 'same-batch-bump',
	'orgs/access-writes.ts': 'same-batch-bump',
	'orgs/offboarding.ts': 'same-batch-bump',
	'orgs/convert-personal-org.ts': 'same-batch-bump',
	'credentials/credential-grant-cleanup.ts': 'same-batch-bump',
	'identity/permissions-db.ts': 'same-batch-bump',
	'execution-contexts/service.ts': 'same-batch-bump',
	'orgs/soft-delete.ts': 'org-tombstone-then-restore-bump',
	'orgs/provision.ts': 'org-row-lifecycle',
	'account/data-targets.ts': 'person-row-gone',
}

const genericWriters = new Set([
	'orgs/soft-delete.ts',
	'account/data-targets.ts',
])
const genericWritePattern = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\$\{/

function sourceFiles() {
	return readdirSync(workerSrc, { recursive: true, encoding: 'utf8' })
		.filter(
			(file) =>
				file.endsWith('.ts') &&
				!file.endsWith('.test.ts') &&
				!file.startsWith('test-support/') &&
				!file.endsWith('-test-schema.ts'),
		)
		.sort()
}

function accessWritesIn(source: string) {
	const tables = new Set<string>()
	for (const literal of source.match(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g) ?? []) {
		const table = accessTableWrittenBy(literal)
		if (table) tables.add(table)
	}
	return tables
}

test('every module that writes an access table is a known writer with a documented invalidation', () => {
	const found = new Map<string, Set<string>>()
	for (const file of sourceFiles()) {
		const source = readFileSync(`${workerSrc}${file}`, 'utf8')
		const tables = accessWritesIn(source)
		const mentionsTables = accessEpochGuardedTables.some((table) =>
			new RegExp(`'${table}'`).test(source),
		)
		if (genericWritePattern.test(source) && mentionsTables) {
			tables.add('${table}')
		}
		if (tables.size > 0) found.set(file, tables)
	}
	const unexpected = [...found.keys()].filter((file) => !(file in writers))
	expect(
		unexpected,
		`New access-table writer(s). Bump access_epoch in the same batch and register the file in access-epoch-write-guard.node.test.ts: ${unexpected
			.map((file) => `${file} (${[...found.get(file)!].join(', ')})`)
			.join('; ')}`,
	).toEqual([])
	const stale = Object.keys(writers).filter((file) => !found.has(file))
	expect(stale, 'writers list has entries that no longer write').toEqual([])
	for (const file of genericWriters)
		expect(found.get(file)).toContain('${table}')
})

test('same-batch writers reference the epoch bump in the same module', () => {
	for (const [file, invalidation] of Object.entries(writers)) {
		if (invalidation !== 'same-batch-bump') continue
		const source = readFileSync(`${workerSrc}${file}`, 'utf8')
		expect(
			source.includes('bumpAccessEpochStatement') || bumpsAccessEpoch(source),
			`${file} must bump access_epoch next to its access-table writes`,
		).toBe(true)
	}
})
