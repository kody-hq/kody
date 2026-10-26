import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { packageAppSpendGet } from './package-app-spend.ts'

test('package app spend reads only this package and the current UTC month', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	sqlite.exec(`
		CREATE TABLE usage_attribution_daily (
			user_id TEXT NOT NULL,
			day TEXT NOT NULL,
			package_id TEXT NOT NULL,
			meter TEXT NOT NULL,
			units REAL NOT NULL,
			updated_at TEXT NOT NULL,
			actor_user_id TEXT,
			automation_source TEXT,
			PRIMARY KEY (user_id, day, package_id, meter)
		);
	`)
	const insert = sqlite.prepare(
		`INSERT INTO usage_attribution_daily
			(user_id, day, package_id, meter, units, updated_at, actor_user_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	insert.run(
		'org-a',
		'2026-05-02',
		'package-a',
		'unique_worker_days',
		2,
		'now',
		'visitor-a',
	)
	insert.run(
		'org-a',
		'2026-05-02',
		'package-a',
		'durable_object_rows_read',
		1_000_000,
		'now',
		'visitor-b',
	)
	insert.run(
		'org-a',
		'2026-05-02',
		'package-b',
		'unique_worker_days',
		9,
		'now',
		null,
	)
	insert.run(
		'org-b',
		'2026-05-02',
		'package-a',
		'unique_worker_days',
		7,
		'now',
		null,
	)
	insert.run(
		'org-a',
		'2026-04-30',
		'package-a',
		'unique_worker_days',
		11,
		'now',
		null,
	)
	insert.run(
		'org-a',
		'2026-06-01',
		'package-a',
		'unique_worker_days',
		13,
		'now',
		null,
	)

	const result = await packageAppSpendGet({
		db,
		orgId: 'org-a',
		packageId: 'package-a',
		now: new Date('2026-05-15T10:00:00.000Z'),
	})

	expect(result).toEqual({
		month: '2026-05',
		creditsMicroUsd: 10_000,
		days: [
			{
				day: '2026-05-02',
				creditsMicroUsd: 10_000,
				meters: [
					{
						meter: 'durable_object_rows_read',
						units: 1_000_000,
						creditsMicroUsd: 2_000,
					},
					{
						meter: 'unique_worker_days',
						units: 2,
						creditsMicroUsd: 8_000,
					},
				],
			},
		],
	})
	expect(JSON.stringify(result)).not.toContain('visitor-a')
	expect(JSON.stringify(result)).not.toContain('org-a')
	sqlite.close()
})
