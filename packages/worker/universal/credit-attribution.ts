/**
 * Customer credit attribution: where past-include Worker compute and Rows
 * read landed this UTC month. Package ids come from metering when known;
 * everything else is Ad hoc. Never invents a package. Never surfaces RunLog
 * / platform rows. Customer copy never says UWD.
 */
import { creditDebitCostMicroUsd, type CreditDebitMeter } from './credits.ts'
import { type ComputeOverageWarningResource } from './compute-overage.ts'

/** Empty package_id in D1 / AE blob9 means Ad hoc (direct execute + unknown). */
const creditAttributionAdHocPackageId = ''

export const creditAttributionAdHocName = 'Ad hoc'

/** Top packages shown before Show all expands the same list in place. */
export const creditAttributionDefaultVisiblePackages = 5

export const creditAttributionMeters = [
	'unique_worker_days',
	'durable_object_rows_read',
] as const satisfies ReadonlyArray<CreditDebitMeter>

export type CreditAttributionMeter = (typeof creditAttributionMeters)[number]

/** Usage event types that feed credit attribution (customer billable only). */
export const creditAttributionUsageEventTypes = [
	'dynamic_worker_day',
	'durable_object_rows_read',
] as const

export function creditAttributionMeterFromUsageEventType(
	eventType: string,
): CreditAttributionMeter | null {
	switch (eventType) {
		case 'dynamic_worker_day':
			return 'unique_worker_days'
		case 'durable_object_rows_read':
			return 'durable_object_rows_read'
		default:
			return null
	}
}

export function normalizeCreditAttributionPackageId(
	packageId: string | null | undefined,
): string {
	const trimmed = packageId?.trim() ?? ''
	return trimmed.length > 0 ? trimmed : creditAttributionAdHocPackageId
}

export type CreditAttributionDailyUnit = {
	day: string
	packageId: string
	meter: CreditAttributionMeter
	units: number
}

export type CreditAttributionMeterInclude = {
	meter: CreditAttributionMeter
	include: number
}

type CreditAttributionMeterSplit = {
	meter: CreditAttributionMeter
	/** Customer label: Worker compute / Rows read. */
	label: string
	creditsMicroUsd: number
}

type CreditAttributionCumulativePoint = {
	day: string
	creditsMicroUsd: number
}

export type CreditAttributionRow = {
	packageId: string
	/** Display name (package kodyId/name, or Ad hoc). */
	name: string
	/** Community href when this is a known owned package; null for Ad hoc. */
	href: string | null
	creditsMicroUsd: number
	/** 0–1 share of the period credit total. */
	share: number
	meters: Array<CreditAttributionMeterSplit>
	/** Running total of this row's credits across the period (oldest first). */
	cumulative: Array<CreditAttributionCumulativePoint>
	isAdHoc: boolean
}

export type CreditAttributionBreakdown = {
	month: string
	/** Sum of attributed past-include credits this period. */
	totalCreditsMicroUsd: number
	rows: Array<CreditAttributionRow>
}

const meterLabels = {
	unique_worker_days: 'Worker compute',
	durable_object_rows_read: 'Rows read',
} as const satisfies Record<CreditAttributionMeter, string>

/**
 * Attribute past-include debit cost to packages from daily unit rows.
 * Within each day, billable units (after the month's remaining include) are
 * split proportionally by that day's package unit share — no guessing which
 * package burned the include first.
 */
export function buildCreditAttributionBreakdown(input: {
	month: string
	dailyUnits: ReadonlyArray<CreditAttributionDailyUnit>
	includes: ReadonlyArray<CreditAttributionMeterInclude>
	packageNames: ReadonlyMap<string, string>
	packageHrefs: ReadonlyMap<string, string>
}): CreditAttributionBreakdown {
	const remainingInclude = new Map<CreditAttributionMeter, number>()
	for (const meter of creditAttributionMeters) {
		remainingInclude.set(meter, 0)
	}
	for (const entry of input.includes) {
		remainingInclude.set(entry.meter, nonNegative(entry.include))
	}

	const days = [...new Set(input.dailyUnits.map((row) => row.day))].sort()
	const packageDayCredits = new Map<string, Map<string, number>>()
	const packageMeterCredits = new Map<
		string,
		Map<CreditAttributionMeter, number>
	>()

	for (const day of days) {
		for (const meter of creditAttributionMeters) {
			const dayRows = input.dailyUnits.filter(
				(row) => row.day === day && row.meter === meter && row.units > 0,
			)
			if (dayRows.length === 0) continue
			const dayTotal = dayRows.reduce((sum, row) => sum + row.units, 0)
			const remaining = remainingInclude.get(meter) ?? 0
			const covered = Math.min(remaining, dayTotal)
			remainingInclude.set(meter, remaining - covered)
			const billable = dayTotal - covered
			if (billable <= 0 || dayTotal <= 0) continue
			const dayCredits = creditDebitCostMicroUsd(meter, billable)
			if (dayCredits <= 0) continue
			let attributed = 0
			const allocations = dayRows.map((row, index) => {
				const packageId = normalizeCreditAttributionPackageId(row.packageId)
				const share = row.units / dayTotal
				const isLast = index === dayRows.length - 1
				const credits = isLast
					? dayCredits - attributed
					: Math.floor(dayCredits * share)
				attributed += credits
				return { packageId, credits }
			})
			for (const allocation of allocations) {
				if (allocation.credits <= 0) continue
				const byDay = packageDayCredits.get(allocation.packageId) ?? new Map()
				byDay.set(day, (byDay.get(day) ?? 0) + allocation.credits)
				packageDayCredits.set(allocation.packageId, byDay)
				const byMeter =
					packageMeterCredits.get(allocation.packageId) ?? new Map()
				byMeter.set(meter, (byMeter.get(meter) ?? 0) + allocation.credits)
				packageMeterCredits.set(allocation.packageId, byMeter)
			}
		}
	}

	const packageIds = new Set<string>([
		...packageDayCredits.keys(),
		creditAttributionAdHocPackageId,
	])
	// Drop Ad hoc when it has no credits unless it is the only row we need
	// for an empty-state total of zero (handled below).
	const rows: Array<CreditAttributionRow> = []
	for (const packageId of packageIds) {
		const byMeter = packageMeterCredits.get(packageId) ?? new Map()
		const meters: Array<CreditAttributionMeterSplit> = creditAttributionMeters
			.map((meter) => ({
				meter,
				label: meterLabels[meter],
				creditsMicroUsd: byMeter.get(meter) ?? 0,
			}))
			.filter((entry) => entry.creditsMicroUsd > 0)
		const creditsMicroUsd = meters.reduce(
			(sum, entry) => sum + entry.creditsMicroUsd,
			0,
		)
		const isAdHoc = packageId === creditAttributionAdHocPackageId
		if (!isAdHoc && creditsMicroUsd <= 0) continue
		if (isAdHoc && creditsMicroUsd <= 0 && packageDayCredits.size > 0) {
			// Other packages already cover the spend; skip empty Ad hoc.
			continue
		}
		const byDay = packageDayCredits.get(packageId) ?? new Map()
		let running = 0
		const cumulative = days.map((day) => {
			running += byDay.get(day) ?? 0
			return { day, creditsMicroUsd: running }
		})
		rows.push({
			packageId,
			name: isAdHoc
				? creditAttributionAdHocName
				: (input.packageNames.get(packageId) ?? packageId),
			href: isAdHoc ? null : (input.packageHrefs.get(packageId) ?? null),
			creditsMicroUsd,
			share: 0,
			meters,
			cumulative,
			isAdHoc,
		})
	}

	const totalCreditsMicroUsd = rows.reduce(
		(sum, row) => sum + row.creditsMicroUsd,
		0,
	)
	for (const row of rows) {
		row.share =
			totalCreditsMicroUsd > 0 ? row.creditsMicroUsd / totalCreditsMicroUsd : 0
	}

	rows.sort((left, right) => {
		if (left.isAdHoc !== right.isAdHoc) return left.isAdHoc ? 1 : -1
		if (right.creditsMicroUsd !== left.creditsMicroUsd) {
			return right.creditsMicroUsd - left.creditsMicroUsd
		}
		return left.name.localeCompare(right.name)
	})

	return {
		month: input.month,
		totalCreditsMicroUsd,
		rows,
	}
}

/** One package's slice of the period for the package page. */
export function creditAttributionForPackage(
	breakdown: CreditAttributionBreakdown,
	packageId: string,
): CreditAttributionRow | null {
	const id = normalizeCreditAttributionPackageId(packageId)
	if (id === creditAttributionAdHocPackageId) return null
	const existing = breakdown.rows.find((row) => row.packageId === id)
	if (existing) return existing
	return {
		packageId: id,
		name: id,
		href: null,
		creditsMicroUsd: 0,
		share: 0,
		meters: [],
		cumulative: [],
		isAdHoc: false,
	}
}

export function creditAttributionMeterFromComputeResource(
	resource: ComputeOverageWarningResource,
): CreditAttributionMeter {
	return resource
}

function nonNegative(value: number) {
	if (!Number.isFinite(value) || value <= 0) return 0
	return value
}
