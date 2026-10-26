/**
 * Package-manifest job schedule shapes accepted at publish time.
 * Shared by the worker (`packageJobScheduleSchema`) and the CLI
 * (`kody dev check` / `loadPackageManifest`) so local validation cannot
 * drift from production.
 */

export type PackageJobSchedule =
	| {
			type: 'cron'
			expression: string
	  }
	| {
			type: 'interval'
			every: string
	  }

export const removedOnceJobScheduleMessage =
	"Job schedule type \"once\" was removed: jobs are recurring (cron or interval). For a one-shot run at a set time, delete this job and start a workflow instead: import { workflows } from 'kody:runtime'; await workflows.create({ exportName: './my-export', runAt: '2027-01-01T16:00:00Z', idempotencyKey: 'my-export:2027-01-01', params: {} }). See https://kody.codes/docs/triggers."

export const invalidPackageJobScheduleMessage =
	'Job schedule must be { "type": "cron", "expression": "<5-field cron>" } or { "type": "interval", "every": "<duration such as 15m>" }.'

export type ParsePackageJobScheduleResult =
	| { ok: true; schedule: PackageJobSchedule }
	| {
			ok: false
			message: string
			code: 'once_removed' | 'invalid'
	  }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse a package.json `kody.jobs.*.schedule` value the same way production
 * publish does. Does not validate cron syntax or interval units beyond a
 * non-empty string (runtime/normalize does that later).
 */
export function parsePackageJobSchedule(
	schedule: unknown,
): ParsePackageJobScheduleResult {
	if (isPlainRecord(schedule) && schedule.type === 'once') {
		return {
			ok: false,
			message: removedOnceJobScheduleMessage,
			code: 'once_removed',
		}
	}

	if (!isPlainRecord(schedule) || typeof schedule.type !== 'string') {
		return {
			ok: false,
			message: invalidPackageJobScheduleMessage,
			code: 'invalid',
		}
	}

	switch (schedule.type) {
		case 'cron': {
			if (
				typeof schedule.expression !== 'string' ||
				schedule.expression.length < 1
			) {
				return {
					ok: false,
					message: invalidPackageJobScheduleMessage,
					code: 'invalid',
				}
			}
			return {
				ok: true,
				schedule: {
					type: 'cron',
					expression: schedule.expression,
				},
			}
		}
		case 'interval': {
			if (typeof schedule.every !== 'string' || schedule.every.length < 1) {
				return {
					ok: false,
					message: invalidPackageJobScheduleMessage,
					code: 'invalid',
				}
			}
			return {
				ok: true,
				schedule: {
					type: 'interval',
					every: schedule.every,
				},
			}
		}
		default:
			return {
				ok: false,
				message: invalidPackageJobScheduleMessage,
				code: 'invalid',
			}
	}
}

/** Display / summary string for CLI output and job listings. */
export function formatPackageJobScheduleSummary(
	schedule: PackageJobSchedule,
): string {
	switch (schedule.type) {
		case 'cron':
			return schedule.expression
		case 'interval':
			return `every ${schedule.every}`
		default: {
			const exhaustive: never = schedule
			return exhaustive
		}
	}
}
