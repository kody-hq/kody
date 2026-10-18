import { isRecord } from '@kody-internal/shared/is-record.ts'

/**
 * Operator-facing status for one UTC backup day.
 *
 * Thresholds (all UTC), chosen from the live staging pace observed on
 * 2026-10-18 and from the schedules in `docs/contributing/disaster-recovery.md`:
 *
 * - D1 export is enqueued at 02:15, with hourly catch-up through 05:45. A
 *   missing manifest stays neutral until 06:10 (the staging window close) and
 *   is a failure after that.
 * - Staging starts at 00:30. A day still open 48h after UTC midnight is later
 *   than the documented "within a day or two" steady state (recent summaries
 *   landed 34–59h after midnight and the gap is growing). That is amber while
 *   the cursor is still moving.
 * - No progress advance for 2h matches the exporter watchdog's
 *   `strandedCatchUpActiveMs`. That is a stuck cursor, so it is red.
 * - Catch-up lookback is 14 days. From day-offset 12 only two days of runway
 *   remain, which is not enough at the current ~28h-per-day pace. Red.
 * - The seal cron is hourly at :45. Still unsealed 3h after `completedAt`
 *   means several hourly attempts passed (amber). Red only for an invalid or
 *   unreadable full manifest.
 */

/** 02:15 UTC — primary D1 export. */
const d1ExportDueMinuteUtc = 2 * 60 + 15
/** 06:10 UTC — end of the morning staging window, after D1 catch-up. */
const d1ExportWindowEndMinuteUtc = 6 * 60 + 10
/** 00:30 UTC — staging nightly window opens. */
const stagingWindowStartMinuteUtc = 30
/** Same close as the D1 grace window. */
const stagingWindowEndMinuteUtc = d1ExportWindowEndMinuteUtc

/** Still-open staging after this is late, not failed. */
export const stagingExpectedCompleteMs = 48 * 60 * 60 * 1000
/** Matches exporter `strandedCatchUpActiveMs`. */
export const stagingStuckAfterMs = 2 * 60 * 60 * 1000
/**
 * Exporter catch-up scans this many days before today (plus today).
 * Dashboard "nearing lookback" uses day offset, not this scan width.
 */
export const stagingCatchUpLookbackDays = 14
/** Red once fewer than two full days remain inside the 14-day lookback. */
export const stagingNearingLookbackOffset = 12
/** Amber when a summary has been waiting on the hourly seal this long. */
const sealOverdueAfterMs = 3 * 60 * 60 * 1000
/** Lease length used when progress has no `advancedAt` (exporter fallback). */
const progressLeaseDurationMs = 2 * 60 * 1000

const stagingPhases = [
	'mailbox',
	'run-log',
	'storage',
	'r2',
	'artifacts',
	'finalize',
	'done',
] as const

type StagingPhase = (typeof stagingPhases)[number]

type DayTone = 'neutral' | 'ok' | 'warn' | 'bad'

export type DayCell = {
	tone: DayTone
	label: string
	/** Hover text. Omitted when the label already says the whole thing. */
	detail?: string
}

export type DayCells = {
	d1Manifest: DayCell
	d1Verified: DayCell
	d1Restorable: DayCell
	staging: DayCell
	sealed: DayCell
	sealVerified: DayCell
}

export type StagingProgressFacts = {
	phase: StagingPhase
	revision: number
	advancedAtMs: number | null
	ownerIndex: number | null
}

export type StagingSummaryFacts = {
	completedAtMs: number
}

export type SealFacts = 'absent' | 'verified' | 'invalid' | 'unreadable'

type WindowState = 'pending' | 'due' | 'closed'

export const dayColumnLegend: ReadonlyArray<{
	label: string
	text: string
}> = [
	{
		label: 'D1 manifest',
		text: 'Signed SQL export for each configured database. Due at 02:15 UTC; catch-up runs through 05:45. Pending before 02:15. Missing after 06:10 is a failure.',
	},
	{
		label: 'D1 verified',
		text: 'Ed25519 signature on that manifest. Invalid signature is a failure. Waiting until the manifest exists.',
	},
	{
		label: 'D1 restorable',
		text: 'SQL statement sizes can be imported by D1. Oversized or missing stats is a failure. Legacy backups with no stats stay Unknown.',
	},
	{
		label: 'Staging',
		text: 'Mailbox, RunLog, storage, R2, and artifact export. Starts at 00:30 UTC. In progress, starting, or queued behind an older day is normal. Overdue after 48h while the cursor still moves. Red when nothing has advanced for 2h, the day never started after the window, progress is unreadable, or the day is within 2 days of falling out of the 14-day catch-up lookback.',
	},
	{
		label: 'Sealed',
		text: 'Hourly control plane copied staging into daily/full and signed it. Waiting until the staging summary exists, then due on the hourly :45 run. Amber if still open 3 hours after the summary. Red only when the full manifest is invalid or unreadable.',
	},
	{
		label: 'Seal verified',
		text: 'Signature on the sealed full-day manifest. Verified once sealing succeeds. Invalid signature is a failure.',
	},
]

export function parseStagingProgressFacts(
	value: unknown,
): StagingProgressFacts | null {
	if (!isRecord(value)) return null
	const phase = value.phase
	if (!isStagingPhase(phase)) return null
	const revision =
		typeof value.revision === 'number' && Number.isSafeInteger(value.revision)
			? value.revision
			: 0
	const advancedAtMs = activityAtMs(value)
	const ownerIndex = ownerIndexForPhase(value, phase)
	return { phase, revision, advancedAtMs, ownerIndex }
}

export function deriveDayCells(input: {
	day: string
	now: Date
	today: string
	d1Present: boolean
	d1Verified: boolean | null
	d1Restorable: boolean | null
	stagingSummary: StagingSummaryFacts | null | 'unreadable'
	stagingProgress: StagingProgressFacts | null | 'unreadable'
	/**
	 * Oldest day in the dashboard window that has progress and no summary.
	 * Newer progress-only days are queued behind it.
	 */
	activeStagingDay: string | null
	seal: SealFacts
}): DayCells {
	const d1Window = windowState(input.day, input.now, input.today, {
		startMinute: d1ExportDueMinuteUtc,
		endMinute: d1ExportWindowEndMinuteUtc,
	})
	const stagingWindow = windowState(input.day, input.now, input.today, {
		startMinute: stagingWindowStartMinuteUtc,
		endMinute: stagingWindowEndMinuteUtc,
	})
	const offsetDays = utcDayOffset(input.today, input.day)
	const staging = stagingCell(
		classifyStaging({
			day: input.day,
			now: input.now,
			stagingWindow,
			offsetDays,
			stagingSummary: input.stagingSummary,
			stagingProgress: input.stagingProgress,
			activeStagingDay: input.activeStagingDay,
		}),
	)
	const sealed = sealCell(
		classifySeal(input.seal, input.stagingSummary, input.now),
	)
	return {
		d1Manifest: d1ManifestCell(input.d1Present, d1Window),
		d1Verified: d1VerifiedCell(input.d1Present, input.d1Verified, d1Window),
		d1Restorable: d1RestorableCell(
			input.d1Present,
			input.d1Verified,
			input.d1Restorable,
			d1Window,
		),
		staging,
		sealed: sealed.sealed,
		sealVerified: sealed.verified,
	}
}

function isStagingPhase(value: unknown): value is StagingPhase {
	return (
		typeof value === 'string' &&
		(stagingPhases as ReadonlyArray<string>).includes(value)
	)
}

function activityAtMs(value: Record<string, unknown>): number | null {
	if (typeof value.advancedAt === 'string') {
		const advancedAt = Date.parse(value.advancedAt)
		if (Number.isFinite(advancedAt)) return advancedAt
	}
	if (typeof value.leaseExpiresAt === 'string') {
		const leaseExpiresAt = Date.parse(value.leaseExpiresAt)
		if (Number.isFinite(leaseExpiresAt)) {
			return leaseExpiresAt - progressLeaseDurationMs
		}
	}
	return null
}

function ownerIndexForPhase(
	value: Record<string, unknown>,
	phase: StagingPhase,
): number | null {
	const lane =
		phase === 'run-log'
			? value.runLog
			: phase === 'mailbox'
				? value.mailbox
				: null
	if (!isRecord(lane)) return null
	return typeof lane.ownerIndex === 'number' &&
		Number.isSafeInteger(lane.ownerIndex)
		? lane.ownerIndex
		: null
}

function windowState(
	day: string,
	now: Date,
	today: string,
	bounds: { startMinute: number; endMinute: number },
): WindowState {
	if (day > today) return 'pending'
	if (day < today) return 'closed'
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	if (minutes < bounds.startMinute) return 'pending'
	if (minutes <= bounds.endMinute) return 'due'
	return 'closed'
}

function utcDayOffset(today: string, day: string): number {
	const todayMs = Date.parse(`${today}T00:00:00.000Z`)
	const dayMs = Date.parse(`${day}T00:00:00.000Z`)
	return Math.round((todayMs - dayMs) / (24 * 60 * 60 * 1000))
}

function d1ManifestCell(present: boolean, window: WindowState): DayCell {
	if (present) return { tone: 'ok', label: 'Present' }
	switch (window) {
		case 'pending':
			return { tone: 'neutral', label: 'Pending' }
		case 'due':
			return { tone: 'neutral', label: 'Due' }
		case 'closed':
			return { tone: 'bad', label: 'Missing' }
		default: {
			const exhaustive: never = window
			throw exhaustive
		}
	}
}

function d1VerifiedCell(
	present: boolean,
	verified: boolean | null,
	window: WindowState,
): DayCell {
	if (!present) return waitingOnManifest(window)
	if (verified === true) return { tone: 'ok', label: 'Verified' }
	if (verified === false) return { tone: 'bad', label: 'Invalid signature' }
	return { tone: 'warn', label: 'Unknown' }
}

function d1RestorableCell(
	present: boolean,
	verified: boolean | null,
	restorable: boolean | null,
	window: WindowState,
): DayCell {
	if (!present) return waitingOnManifest(window)
	if (verified === false) return { tone: 'bad', label: 'Blocked' }
	if (restorable === true) return { tone: 'ok', label: 'Restorable' }
	if (restorable === false) return { tone: 'bad', label: 'Not restorable' }
	return { tone: 'warn', label: 'Unknown' }
}

function waitingOnManifest(window: WindowState): DayCell {
	switch (window) {
		case 'pending':
			return { tone: 'neutral', label: 'Pending' }
		case 'due':
			return { tone: 'neutral', label: 'Due' }
		case 'closed':
			return { tone: 'neutral', label: '—' }
		default: {
			const exhaustive: never = window
			throw exhaustive
		}
	}
}

type ProgressPhrase = {
	phase: string
	advanced: string
	stuckAdvance: string
	detail: string
}

type StagingClassification =
	| { kind: 'unreadable' }
	| { kind: 'complete' }
	| { kind: 'pending' }
	| { kind: 'due' }
	| { kind: 'missing' }
	| { kind: 'queued'; behind: string }
	| { kind: 'starting' }
	| { kind: 'not-started' }
	| { kind: 'stuck'; progress: ProgressPhrase; nearingLookback: boolean }
	| { kind: 'nearing-lookback'; progress: ProgressPhrase }
	| { kind: 'overdue'; progress: ProgressPhrase }
	| { kind: 'in-progress'; progress: ProgressPhrase }

function classifyStaging(input: {
	day: string
	now: Date
	stagingWindow: WindowState
	offsetDays: number
	stagingSummary: StagingSummaryFacts | null | 'unreadable'
	stagingProgress: StagingProgressFacts | null | 'unreadable'
	activeStagingDay: string | null
}): StagingClassification {
	if (input.stagingSummary === 'unreadable') return { kind: 'unreadable' }
	if (input.stagingSummary) return { kind: 'complete' }
	if (input.stagingProgress === 'unreadable') return { kind: 'unreadable' }
	if (input.stagingProgress === null) {
		switch (input.stagingWindow) {
			case 'pending':
				return { kind: 'pending' }
			case 'due':
				return { kind: 'due' }
			case 'closed':
				return { kind: 'missing' }
			default: {
				const exhaustive: never = input.stagingWindow
				throw exhaustive
			}
		}
	}
	if (input.activeStagingDay !== null && input.activeStagingDay < input.day) {
		return { kind: 'queued', behind: input.activeStagingDay }
	}
	const progress = progressPhrase(input.stagingProgress, input.now)
	const nearing = input.offsetDays >= stagingNearingLookbackOffset
	const started =
		input.stagingProgress.revision > 0 ||
		input.stagingProgress.advancedAtMs !== null
	const idleMs =
		input.stagingProgress.advancedAtMs === null
			? null
			: input.now.getTime() - input.stagingProgress.advancedAtMs
	// Same boundary as the watchdog: active only while age < 2h, so exactly 2h is stuck.
	const stuck = started && idleMs !== null && idleMs >= stagingStuckAfterMs
	if (stuck) return { kind: 'stuck', progress, nearingLookback: nearing }
	if (nearing) return { kind: 'nearing-lookback', progress }
	if (!started) {
		switch (input.stagingWindow) {
			case 'pending':
				return { kind: 'pending' }
			case 'due':
				return { kind: 'starting' }
			case 'closed':
				// The oldest stranded day can be a revision-0 seed for a few
				// minutes after the previous day finishes, before the next
				// 5-minute tick. That is waiting, not a failure. A seed that
				// is not the active day still falls through as not started.
				if (input.activeStagingDay === input.day) {
					return { kind: 'starting' }
				}
				return { kind: 'not-started' }
			default: {
				const exhaustive: never = input.stagingWindow
				throw exhaustive
			}
		}
	}
	const ageMs = input.now.getTime() - Date.parse(`${input.day}T00:00:00.000Z`)
	if (ageMs >= stagingExpectedCompleteMs) return { kind: 'overdue', progress }
	return { kind: 'in-progress', progress }
}

function stagingCell(classification: StagingClassification): DayCell {
	switch (classification.kind) {
		case 'unreadable':
			return { tone: 'bad', label: 'Unreadable' }
		case 'complete':
			return { tone: 'ok', label: 'Complete' }
		case 'pending':
			return { tone: 'neutral', label: 'Pending' }
		case 'due':
			return { tone: 'neutral', label: 'Due' }
		case 'missing':
			return { tone: 'bad', label: 'Missing' }
		case 'queued':
			return {
				tone: 'neutral',
				label: `Queued behind ${classification.behind}`,
			}
		case 'starting':
			return { tone: 'neutral', label: 'Starting' }
		case 'not-started':
			return { tone: 'bad', label: 'Not started' }
		case 'stuck':
			return {
				tone: 'bad',
				label: classification.nearingLookback
					? `Stuck · nearing lookback · ${classification.progress.phase} phase · ${classification.progress.stuckAdvance}`
					: `Stuck · ${classification.progress.phase} phase · ${classification.progress.stuckAdvance}`,
				detail: classification.progress.detail,
			}
		case 'nearing-lookback':
			return {
				tone: 'bad',
				label: `Nearing lookback · ${classification.progress.phase} phase · ${classification.progress.advanced}`,
				detail: classification.progress.detail,
			}
		case 'overdue':
			return {
				tone: 'warn',
				label: `Overdue · ${classification.progress.phase} phase · ${classification.progress.advanced}`,
				detail: classification.progress.detail,
			}
		case 'in-progress':
			return {
				tone: 'neutral',
				label: `In progress · ${classification.progress.phase} phase · ${classification.progress.advanced}`,
				detail: classification.progress.detail,
			}
		default: {
			const exhaustive: never = classification
			throw exhaustive
		}
	}
}

function progressPhrase(
	progress: StagingProgressFacts,
	now: Date,
): ProgressPhrase {
	const phase = phaseLabel(progress.phase)
	const advanced =
		progress.advancedAtMs === null
			? 'advance time unknown'
			: advancedPhrase(now.getTime() - progress.advancedAtMs)
	const stuckAdvance =
		progress.advancedAtMs === null
			? 'no recent advance'
			: `no advance for ${elapsedLabel(now.getTime() - progress.advancedAtMs)}`
	const detailParts = [`revision ${progress.revision}`]
	if (
		progress.ownerIndex !== null &&
		(progress.phase === 'mailbox' || progress.phase === 'run-log')
	) {
		detailParts.push(`${phase} owner ${progress.ownerIndex}`)
	}
	return {
		phase,
		advanced,
		stuckAdvance,
		detail: detailParts.join(' · '),
	}
}

function phaseLabel(phase: StagingPhase): string {
	switch (phase) {
		case 'mailbox':
			return 'mailbox'
		case 'run-log':
			return 'run log'
		case 'storage':
			return 'storage'
		case 'r2':
			return 'R2'
		case 'artifacts':
			return 'artifacts'
		case 'finalize':
			return 'finalize'
		case 'done':
			return 'finishing'
		default: {
			const exhaustive: never = phase
			throw exhaustive
		}
	}
}

function advancedPhrase(elapsedMs: number): string {
	const elapsed = elapsedLabel(elapsedMs)
	if (elapsed === 'just now') return 'advanced just now'
	return `advanced ${elapsed} ago`
}

function elapsedLabel(elapsedMs: number): string {
	const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${hours}h`
	return `${Math.floor(hours / 24)}d`
}

type SealClassification =
	| { kind: 'unreadable' }
	| { kind: 'invalid' }
	| { kind: 'sealed' }
	| { kind: 'waiting' }
	| { kind: 'due' }
	| { kind: 'overdue' }

function classifySeal(
	seal: SealFacts,
	summary: StagingSummaryFacts | null | 'unreadable',
	now: Date,
): SealClassification {
	switch (seal) {
		case 'unreadable':
			return { kind: 'unreadable' }
		case 'invalid':
			return { kind: 'invalid' }
		case 'verified':
			return { kind: 'sealed' }
		case 'absent': {
			if (summary === null || summary === 'unreadable') {
				return { kind: 'waiting' }
			}
			const ageMs = now.getTime() - summary.completedAtMs
			if (ageMs >= sealOverdueAfterMs) return { kind: 'overdue' }
			return { kind: 'due' }
		}
		default: {
			const exhaustive: never = seal
			throw exhaustive
		}
	}
}

function sealCell(classification: SealClassification): {
	sealed: DayCell
	verified: DayCell
} {
	switch (classification.kind) {
		case 'unreadable':
			return {
				sealed: { tone: 'bad', label: 'Unreadable' },
				verified: { tone: 'bad', label: 'Unreadable' },
			}
		case 'invalid':
			return {
				sealed: { tone: 'bad', label: 'Invalid signature' },
				verified: { tone: 'bad', label: 'Invalid' },
			}
		case 'sealed':
			return {
				sealed: { tone: 'ok', label: 'Sealed' },
				verified: { tone: 'ok', label: 'Verified' },
			}
		case 'waiting':
			return {
				sealed: { tone: 'neutral', label: 'Waiting for staging' },
				verified: { tone: 'neutral', label: 'Waiting' },
			}
		case 'due':
			return {
				sealed: { tone: 'neutral', label: 'Due (hourly seal)' },
				verified: { tone: 'neutral', label: 'Waiting' },
			}
		case 'overdue':
			return {
				sealed: { tone: 'warn', label: 'Overdue' },
				verified: { tone: 'neutral', label: 'Waiting' },
			}
		default: {
			const exhaustive: never = classification
			throw exhaustive
		}
	}
}
