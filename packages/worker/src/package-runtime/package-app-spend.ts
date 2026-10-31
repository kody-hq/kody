import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	creditDebitCostMicroUsd,
	type CreditDebitMeter,
} from '#universal/credits.ts'

export async function packageAppSpendGet(input: {
	db: D1Database
	orgId: string
	packageId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const month = utcMonthKey(now)
	const nextMonth = utcMonthKey(
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
	)
	const result = await input.db
		.prepare(
			`SELECT day, meter, units
			 FROM usage_attribution_daily
			 WHERE user_id = ? AND package_id = ?
				AND day >= ? AND day < ?
				AND meter IN (?, ?)
			 ORDER BY day, meter`,
		)
		.bind(
			input.orgId,
			input.packageId,
			`${month}-01`,
			`${nextMonth}-01`,
			'unique_worker_days',
			'durable_object_rows_read',
		)
		.all<{ day: string; meter: string; units: number }>()
	const byDay = new Map<
		string,
		{
			creditsMicroUsd: number
			meters: Array<{
				meter: CreditDebitMeter
				units: number
				creditsMicroUsd: number
			}>
		}
	>()
	for (const row of result.results ?? []) {
		if (
			row.meter !== 'unique_worker_days' &&
			row.meter !== 'durable_object_rows_read'
		) {
			continue
		}
		const meter = row.meter as CreditDebitMeter
		const units = Number(row.units) || 0
		const creditsMicroUsd = creditDebitCostMicroUsd(meter, units)
		const day = byDay.get(row.day) ?? { creditsMicroUsd: 0, meters: [] }
		day.creditsMicroUsd += creditsMicroUsd
		day.meters.push({ meter, units, creditsMicroUsd })
		byDay.set(row.day, day)
	}
	const days = [...byDay.entries()].map(([day, value]) => ({
		day,
		...value,
	}))
	return {
		month,
		creditsMicroUsd: days.reduce(
			(total, day) => total + day.creditsMicroUsd,
			0,
		),
		days,
	}
}
