import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { loadAdHocConnectionUsage } from './credit-attribution.ts'
import { ensureUsageRollupsTestSchema } from './test-schema.ts'

const now = new Date('2026-10-31T15:00:00.000Z')

async function insertRow(row: {
	userId: string
	day: string
	kind: string
	credentialId: string
	packageId: string
	eventType: string
	units: number
}) {
	await env.APP_DB.prepare(
		`INSERT INTO usage_connection_daily (
			user_id, day, credential_kind, holder_user_id, credential_id,
			package_id, event_type, units
		) VALUES (?, ?, ?, 'person-1', ?, ?, ?, ?)`,
	)
		.bind(
			row.userId,
			row.day,
			row.kind,
			row.credentialId,
			row.packageId,
			row.eventType,
			row.units,
		)
		.run()
}

test('reads only Ad hoc worker loads in the retained window of this month', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userId = 'org-adhoc-connections'
	const base = { userId, kind: 'cli', credentialId: 'cli-1' }
	await insertRow({
		...base,
		day: '2026-10-30',
		packageId: '',
		eventType: 'dynamic_worker_day',
		units: 5,
	})
	await insertRow({
		...base,
		day: '2026-10-29',
		packageId: '',
		eventType: 'dynamic_worker_day',
		units: 2,
	})
	// Package work, other event types, and days past retention stay out.
	await insertRow({
		...base,
		day: '2026-10-30',
		packageId: 'pkg-1',
		eventType: 'dynamic_worker_day',
		units: 9,
	})
	await insertRow({
		...base,
		day: '2026-10-30',
		packageId: '',
		eventType: 'execute',
		units: 50,
	})
	await insertRow({
		...base,
		day: '2026-10-10',
		packageId: '',
		eventType: 'dynamic_worker_day',
		units: 7,
	})
	await insertRow({
		...base,
		userId: 'org-other',
		day: '2026-10-30',
		packageId: '',
		eventType: 'dynamic_worker_day',
		units: 3,
	})

	const summary = await loadAdHocConnectionUsage({
		db: env.APP_DB,
		stableUserId: userId,
		now,
	})
	expect(summary.sinceDay).toBe('2026-10-18')
	expect(summary.rows).toEqual([
		{ id: 'Kody CLI', label: 'Kody CLI', workerUnits: 7 },
	])
})

test('starts at the first of the month early in the month', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const summary = await loadAdHocConnectionUsage({
		db: env.APP_DB,
		stableUserId: 'org-empty',
		now: new Date('2026-11-03T00:00:00.000Z'),
	})
	expect(summary).toEqual({
		sinceDay: '2026-11-01',
		rows: [],
		otherWorkerUnits: 0,
	})
})
