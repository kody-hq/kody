import { expect, test } from 'vitest'
import { toCreditsDebitMeters } from '#app/account-credits-data.ts'

test('toCreditsDebitMeters maps usage meters into the credits rate card', () => {
	const rows = toCreditsDebitMeters([
		{
			resource: 'unique_worker_days',
			label: 'Worker compute',
			current: 400,
			include: 350,
			percentOfLimit: 400 / 350,
		},
		{
			resource: 'durable_object_rows_read',
			label: 'Rows read',
			current: 1_000_000,
			include: 5_000_000_000,
			percentOfLimit: 1_000_000 / 5_000_000_000,
		},
		{
			resource: 'cpu_ms',
			label: 'CPU',
			current: 99,
			include: 10,
			percentOfLimit: 9.9,
		},
	])
	expect(rows).toHaveLength(2)
	expect(rows[0]).toMatchObject({
		meter: 'unique_worker_days',
		include: 350,
		used: 400,
		pastInclude: 50,
		estCreditsMicroUsd: 200_000,
	})
	expect(rows[1]).toMatchObject({
		meter: 'durable_object_rows_read',
		pastInclude: 0,
		estCreditsMicroUsd: 0,
	})
})
