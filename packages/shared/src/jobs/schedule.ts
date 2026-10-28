import { Cron } from 'croner'
import { type JobRecord, type JobSchedule, type JobView } from './types.ts'

const defaultJobTimezone = 'UTC'

const cronFieldPattern = /\s+/
const intervalPattern = /^(\d+)\s*(ms|s|m|h|d)$/i
const intervalUnitMs = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
} as const

export function formatJobError(error: unknown): string {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	return String(error)
}

function assertNeverJobSchedule(schedule: never): never {
	throw new Error(`Unhandled job schedule type: ${JSON.stringify(schedule)}`)
}

export function normalizeJobTimezone(timezone?: string | null) {
	return timezone?.trim() || defaultJobTimezone
}

function assertValidJobTimezone(timezone: string) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
	} catch {
		throw new Error(`Invalid IANA timezone "${timezone}".`)
	}
}

function assertValidCronExpression(expression: string) {
	const trimmed = expression.trim()
	const fields = trimmed.split(cronFieldPattern).filter(Boolean)
	if (fields.length !== 5) {
		throw new Error(
			'Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		)
	}
	const normalized = fields.join(' ')
	try {
		new Cron(normalized, { paused: true })
	} catch (error) {
		throw new Error(`Invalid cron expression: ${formatJobError(error)}`)
	}
	return normalized
}

function parseUtcIsoTimestamp(value: string, label: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error(`${label} requires a non-empty UTC ISO timestamp.`)
	}
	if (!/(?:Z|[+-]00:00)$/i.test(trimmed)) {
		throw new Error(
			`${label} must use an ISO 8601 UTC timestamp (for example 2026-04-17T15:00:00Z).`,
		)
	}
	const calendarMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T/)
	if (calendarMatch?.[1] && calendarMatch[2] && calendarMatch[3]) {
		const year = Number.parseInt(calendarMatch[1], 10)
		const month = Number.parseInt(calendarMatch[2], 10)
		const day = Number.parseInt(calendarMatch[3], 10)
		const reconstructed = new Date(Date.UTC(year, month - 1, day))
		if (
			reconstructed.getUTCFullYear() !== year ||
			reconstructed.getUTCMonth() !== month - 1 ||
			reconstructed.getUTCDate() !== day
		) {
			throw new Error(`${label} requires a valid ISO 8601 calendar date.`)
		}
	}
	const parsed = new Date(trimmed)
	if (Number.isNaN(parsed.valueOf())) {
		throw new Error(`${label} requires a valid ISO 8601 timestamp.`)
	}
	return parsed
}

/**
 * Normalize an optional job expiry timestamp. Pass `null`/`undefined` for no
 * expiry; otherwise require a UTC ISO string and return canonical ISO form.
 */
export function normalizeJobExpiresAt(
	expiresAt: string | null | undefined,
): string | null {
	if (expiresAt == null) return null
	return parseUtcIsoTimestamp(expiresAt, 'expires_at').toISOString()
}

export function isJobExpired(
	job: Pick<JobRecord, 'expiresAt'>,
	now = new Date(),
) {
	if (job.expiresAt == null) return false
	const expiresAtMs = new Date(job.expiresAt).valueOf()
	if (!Number.isFinite(expiresAtMs)) return false
	return expiresAtMs <= now.valueOf()
}

function parseIntervalEvery(every: string) {
	const trimmed = every.trim()
	if (!trimmed) {
		throw new Error(
			'Interval schedules require a non-empty duration such as "15m" or "1h".',
		)
	}
	const match = trimmed.match(intervalPattern)
	if (!match?.[1] || !match[2]) {
		throw new Error(
			'Interval schedules must use "<positive integer><unit>" with unit ms, s, m, h, or d.',
		)
	}
	const amount = Number.parseInt(match[1], 10)
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error('Interval schedules require a positive duration amount.')
	}
	const unit = match[2].toLowerCase() as keyof typeof intervalUnitMs
	return {
		every: `${amount}${unit}`,
		everyMs: amount * intervalUnitMs[unit],
	}
}

export function computeNextRunAt(input: {
	schedule: JobSchedule
	timezone?: string | null
	from?: Date | string | null
}) {
	const timezone = normalizeJobTimezone(input.timezone)
	const from =
		input.from instanceof Date
			? input.from
			: input.from
				? new Date(input.from)
				: new Date()
	if (Number.isNaN(from.valueOf())) {
		throw new Error(
			'Cannot compute the next run time from an invalid reference date.',
		)
	}
	switch (input.schedule.type) {
		case 'interval':
			return new Date(
				from.valueOf() + parseIntervalEvery(input.schedule.every).everyMs,
			).toISOString()
		case 'cron': {
			assertValidJobTimezone(timezone)
			const expression = assertValidCronExpression(input.schedule.expression)
			const cron = new Cron(expression, {
				paused: true,
				timezone,
			})
			const nextRun = cron.nextRun(from)
			if (!nextRun) {
				throw new Error('Cron expression does not produce a future run time.')
			}
			return nextRun.toISOString()
		}
	}
	return assertNeverJobSchedule(input.schedule)
}

/**
 * Advance past a claimed/completed occurrence. Using wall-clock `now` here
 * drops intermediate cron/interval fires when a tick settles late; advancing
 * from the occurrence keeps at-most-one catch-up per pass (the next slot after
 * this one stays due until a later alarm drains it).
 */
export function computeNextRunAtAfterOccurrence(input: {
	schedule: JobSchedule
	timezone?: string | null
	scheduledFor: Date | string
}) {
	return computeNextRunAt({
		schedule: input.schedule,
		timezone: input.timezone,
		from: input.scheduledFor,
	})
}

export function normalizeJobSchedule(schedule: JobSchedule) {
	switch (schedule.type) {
		case 'interval':
			return {
				type: 'interval' as const,
				every: parseIntervalEvery(schedule.every).every,
			}
		case 'cron':
			return {
				type: 'cron' as const,
				expression: assertValidCronExpression(schedule.expression),
			}
	}
	return assertNeverJobSchedule(schedule)
}

const cronIntervalSampleCount = 24

/**
 * Smallest gap between recurring firings. Crons that do not produce two
 * future runs return null.
 */
export function estimateScheduleMinIntervalMs(input: {
	schedule: JobSchedule
	timezone?: string | null
	from?: Date | string | null
}): number | null {
	const schedule = normalizeJobSchedule(input.schedule)
	switch (schedule.type) {
		case 'interval':
			return parseIntervalEvery(schedule.every).everyMs
		case 'cron': {
			const timezone = normalizeJobTimezone(input.timezone)
			assertValidJobTimezone(timezone)
			const from =
				input.from instanceof Date
					? input.from
					: input.from
						? new Date(input.from)
						: new Date()
			if (Number.isNaN(from.valueOf())) {
				throw new Error(
					'Cannot estimate a cron interval from an invalid reference date.',
				)
			}
			const cron = new Cron(schedule.expression, {
				paused: true,
				timezone,
			})
			const dates: Array<Date> = []
			let cursor = from
			for (let i = 0; i < cronIntervalSampleCount; i += 1) {
				const next = cron.nextRun(cursor)
				if (!next) break
				dates.push(next)
				cursor = next
			}
			if (dates.length < 2) return null
			let min = Number.POSITIVE_INFINITY
			for (let i = 1; i < dates.length; i += 1) {
				const previous = dates[i - 1]
				const current = dates[i]
				if (!previous || !current) continue
				min = Math.min(min, current.getTime() - previous.getTime())
			}
			return Number.isFinite(min) ? min : null
		}
	}
	return assertNeverJobSchedule(schedule)
}

export function formatScheduleSummary(input: {
	schedule: JobSchedule
	timezone?: string | null
}) {
	const timezone = normalizeJobTimezone(input.timezone)
	switch (input.schedule.type) {
		case 'interval':
			return `Runs every ${parseIntervalEvery(input.schedule.every).every}`
		case 'cron':
			return `Runs on cron "${assertValidCronExpression(input.schedule.expression)}" in ${timezone}`
	}
	return assertNeverJobSchedule(input.schedule)
}

export function isJobDue(job: JobRecord, now = new Date()) {
	if (!job.enabled || job.killSwitchEnabled || isJobExpired(job, now)) {
		return false
	}
	return new Date(job.nextRunAt).valueOf() <= now.valueOf()
}

export function toJobView(job: JobRecord): JobView {
	const { userId: _userId, ...rest } = job
	return {
		...rest,
		timezone: normalizeJobTimezone(job.timezone),
		scheduleSummary: formatScheduleSummary({
			schedule: job.schedule,
			timezone: job.timezone,
		}),
	}
}
