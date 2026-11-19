import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { readAttributionLogReport } from './attribution-log-report.ts'

function makeDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0281-credential-attribution-log.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const insert = sqlite.prepare(
		`INSERT INTO credential_attribution_log (day, owner_id, credential_id, kind, surface, pattern, run_package_id, bound_package_id, credential_name, first_seen_at, last_seen_at, observations)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'secret-name', ?, ?, ?)`,
	)
	const add = (
		day: string,
		owner: string,
		kind: string,
		runPackageId: string,
		observations: number,
	) =>
		insert.run(
			day,
			owner,
			`credential-${owner}`,
			kind,
			'hosted',
			'shared_fetch',
			runPackageId,
			'',
			`${day}T01:00:00Z`,
			`${day}T02:00:00Z`,
			observations,
		)
	const db = {
		prepare: (sql: string) => ({
			bind: (...values: Array<string | number>) => ({
				all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
			}),
		}),
	} as unknown as D1Database
	return { db, add }
}

const now = new Date('2026-11-16T12:00:00Z')

test('reports counts by kind and by package for the days asked for, without names or owner ids', async () => {
	const { db, add } = makeDb()
	add('2026-11-16', 'one', 'run_package_unbound', 'package-a', 3)
	add('2026-11-16', 'two', 'run_package_unbound', 'package-a', 2)
	add('2026-11-15', 'one', 'ad_hoc', '', 4)
	add('2026-11-10', 'one', 'ad_hoc', '', 9)
	const report = await readAttributionLogReport({ db, days: 2, now })
	expect(report.sinceDay).toBe('2026-11-15')
	expect(report.totals).toEqual([
		{
			kind: 'ad_hoc',
			surface: 'hosted',
			pattern: 'shared_fetch',
			rows: 1,
			observations: 4,
			owners: 1,
			credentials: 1,
		},
		{
			kind: 'run_package_unbound',
			surface: 'hosted',
			pattern: 'shared_fetch',
			rows: 2,
			observations: 5,
			owners: 2,
			credentials: 2,
		},
	])
	expect(report.packages[0]).toEqual({
		kind: 'run_package_unbound',
		surface: 'hosted',
		pattern: 'shared_fetch',
		runPackageId: 'package-a',
		boundPackageId: '',
		changedIntrinsics: '',
		observations: 5,
		owners: 2,
		credentials: 2,
		firstSeenAt: '2026-11-16T01:00:00Z',
		lastSeenAt: '2026-11-16T02:00:00Z',
	})
	expect(JSON.stringify(report)).not.toMatch(/secret-name|credential-one/)
})

test('a package filter keeps only rows that name one of the packages', async () => {
	const { db, add } = makeDb()
	add('2026-11-16', 'one', 'run_package_unbound', 'package-a', 3)
	add('2026-11-16', 'one', 'run_package_unbound', 'package-b', 7)
	const report = await readAttributionLogReport({
		db,
		days: 1,
		now,
		packageIds: ['package-b', 'package-c'],
	})
	expect(report.packages.map((row) => row.runPackageId)).toEqual(['package-b'])
	expect(report.totals[0]?.observations).toBe(7)
})
