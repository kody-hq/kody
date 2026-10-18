import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	deriveDayCells,
	parseStagingProgressFacts,
	stagingExpectedCompleteMs,
	stagingNearingLookbackOffset,
	stagingStuckAfterMs,
	type SealFacts,
	type StagingProgressFacts,
	type StagingSummaryFacts,
} from './day-status.ts'

const now = new Date('2026-10-18T03:10:00.000Z')
const today = '2026-10-18'

function progress(
	day: string,
	overrides: Partial<StagingProgressFacts> = {},
): StagingProgressFacts {
	return {
		phase: 'mailbox',
		revision: 10,
		advancedAtMs: now.getTime() - 3 * 60_000,
		ownerIndex: 736,
		...overrides,
		...(overrides.phase ? { phase: overrides.phase } : {}),
	}
}

function derive(input: {
	day: string
	at?: Date
	d1Present?: boolean
	d1Verified?: boolean | null
	d1Restorable?: boolean | null
	stagingSummary?: StagingSummaryFacts | null | 'unreadable'
	stagingProgress?: StagingProgressFacts | null | 'unreadable'
	activeStagingDay?: string | null
	seal?: SealFacts
}) {
	const at = input.at ?? now
	return deriveDayCells({
		day: input.day,
		now: at,
		today: at.toISOString().slice(0, 10),
		d1Present: input.d1Present ?? true,
		d1Verified: input.d1Verified === undefined ? true : input.d1Verified,
		d1Restorable: input.d1Restorable === undefined ? true : input.d1Restorable,
		stagingSummary: input.stagingSummary ?? null,
		stagingProgress: input.stagingProgress ?? null,
		activeStagingDay: input.activeStagingDay ?? null,
		seal: input.seal ?? 'absent',
	})
}

test('a day before the morning windows is pending, not a failure', () => {
	const cells = derive({
		day: today,
		at: new Date('2026-10-18T00:10:00.000Z'),
		d1Present: false,
		d1Verified: null,
		d1Restorable: null,
	})
	assert.equal(cells.d1Manifest.label, 'Pending')
	assert.equal(cells.d1Manifest.tone, 'neutral')
	assert.equal(cells.d1Verified.label, 'Pending')
	assert.equal(cells.staging.label, 'Pending')
	assert.equal(cells.sealed.label, 'Waiting for staging')
	assert.equal(cells.sealVerified.label, 'Waiting')
	for (const cell of Object.values(cells)) {
		assert.notEqual(cell.tone, 'bad')
	}
})

test('during the D1 window a missing manifest is due, and staging that has opened is due', () => {
	const cells = derive({
		day: today,
		d1Present: false,
		d1Verified: false,
		d1Restorable: false,
	})
	assert.equal(cells.d1Manifest.label, 'Due')
	assert.equal(cells.d1Manifest.tone, 'neutral')
	assert.equal(cells.d1Verified.tone, 'neutral')
	assert.equal(cells.d1Restorable.tone, 'neutral')
	assert.equal(cells.staging.label, 'Due')
	assert.equal(cells.staging.tone, 'neutral')
})

test('after the morning window a missing manifest and missing staging are failures', () => {
	const cells = derive({
		day: today,
		at: new Date('2026-10-18T12:00:00.000Z'),
		d1Present: false,
		d1Verified: false,
		d1Restorable: false,
	})
	assert.deepEqual(cells.d1Manifest, { tone: 'bad', label: 'Missing' })
	assert.equal(cells.d1Verified.label, '—')
	assert.equal(cells.d1Verified.tone, 'neutral')
	assert.equal(cells.staging.label, 'Missing')
	assert.equal(cells.staging.tone, 'bad')
	assert.equal(cells.sealed.label, 'Waiting for staging')
})

test('verified restorable D1 is green, and dependent columns do not repeat a raw no', () => {
	const cells = derive({
		day: '2026-10-16',
		stagingProgress: progress('2026-10-16'),
		activeStagingDay: '2026-10-16',
	})
	assert.equal(cells.d1Manifest.label, 'Present')
	assert.equal(cells.d1Verified.label, 'Verified')
	assert.equal(cells.d1Restorable.label, 'Restorable')
	assert.equal(cells.d1Manifest.tone, 'ok')
})

test('an invalid D1 signature is red and blocks restorability', () => {
	const cells = derive({
		day: '2026-10-16',
		d1Verified: false,
		d1Restorable: false,
		stagingSummary: { completedAtMs: now.getTime() },
		seal: 'verified',
	})
	assert.equal(cells.d1Verified.label, 'Invalid signature')
	assert.equal(cells.d1Verified.tone, 'bad')
	assert.equal(cells.d1Restorable.label, 'Blocked')
	assert.equal(cells.d1Restorable.tone, 'bad')
})

test('unrestorable SQL and legacy unknown stats are distinct', () => {
	const unrestorable = derive({
		day: '2026-10-16',
		d1Restorable: false,
		stagingSummary: { completedAtMs: now.getTime() },
		seal: 'verified',
	})
	assert.equal(unrestorable.d1Restorable.label, 'Not restorable')
	assert.equal(unrestorable.d1Restorable.tone, 'bad')

	const legacy = derive({
		day: '2026-10-16',
		d1Restorable: null,
		stagingSummary: { completedAtMs: now.getTime() },
		seal: 'verified',
	})
	assert.equal(legacy.d1Restorable.label, 'Unknown')
	assert.equal(legacy.d1Restorable.tone, 'warn')
})

test('the live 2026-10-18 backlog is queued or overdue, not a red no', () => {
	const active = progress('2026-10-16')
	const queuedSeed: StagingProgressFacts = {
		phase: 'mailbox',
		revision: 0,
		advancedAtMs: null,
		ownerIndex: 0,
	}
	const day18 = derive({
		day: '2026-10-18',
		d1Present: true,
		stagingProgress: queuedSeed,
		activeStagingDay: '2026-10-16',
	})
	const day17 = derive({
		day: '2026-10-17',
		stagingProgress: queuedSeed,
		activeStagingDay: '2026-10-16',
	})
	const day16 = derive({
		day: '2026-10-16',
		stagingProgress: active,
		activeStagingDay: '2026-10-16',
	})
	assert.equal(day18.staging.label, 'Queued behind 2026-10-16')
	assert.equal(day18.staging.tone, 'neutral')
	assert.equal(day18.sealed.label, 'Waiting for staging')
	assert.equal(day17.staging.label, 'Queued behind 2026-10-16')
	assert.equal(day17.staging.tone, 'neutral')
	assert.equal(day16.staging.label, 'Overdue · mailbox phase · advanced 3m ago')
	assert.equal(day16.staging.tone, 'warn')
	assert.match(day16.staging.detail ?? '', /mailbox owner 736/)
	for (const cells of [day18, day17, day16]) {
		assert.notEqual(cells.staging.tone, 'bad')
		assert.notEqual(cells.sealed.tone, 'bad')
	}
})

test('staging inside the 48h window stays neutral while it advances', () => {
	const cells = derive({
		day: '2026-10-17',
		stagingProgress: progress('2026-10-17', { ownerIndex: 12 }),
		activeStagingDay: '2026-10-17',
	})
	assert.equal(
		cells.staging.label,
		'In progress · mailbox phase · advanced 3m ago',
	)
	assert.equal(cells.staging.tone, 'neutral')
	const ageMs = now.getTime() - Date.parse('2026-10-17T00:00:00.000Z')
	assert.ok(ageMs < stagingExpectedCompleteMs)
})

test('a cursor with no advance for over 2h is stuck', () => {
	const cells = derive({
		day: '2026-10-17',
		stagingProgress: progress('2026-10-17', {
			advancedAtMs: now.getTime() - stagingStuckAfterMs - 60_000,
		}),
		activeStagingDay: '2026-10-17',
	})
	assert.equal(cells.staging.tone, 'bad')
	assert.match(
		cells.staging.label,
		/^Stuck · mailbox phase · no advance for 2h/,
	)
})

test('a day inside two days of the lookback is red even while it advances', () => {
	const day = '2026-10-06'
	const offset = Math.round(
		(Date.parse(`${today}T00:00:00.000Z`) -
			Date.parse(`${day}T00:00:00.000Z`)) /
			(24 * 60 * 60 * 1000),
	)
	assert.equal(offset, stagingNearingLookbackOffset)
	const cells = derive({
		day,
		stagingProgress: progress(day),
		activeStagingDay: day,
	})
	assert.equal(cells.staging.tone, 'bad')
	assert.match(cells.staging.label, /^Nearing lookback · mailbox phase/)
})

test('stuck and nearing lookback are both visible', () => {
	const cells = derive({
		day: '2026-10-06',
		stagingProgress: progress('2026-10-06', {
			advancedAtMs: now.getTime() - 5 * 60 * 60_000,
		}),
		activeStagingDay: '2026-10-06',
	})
	assert.match(cells.staging.label, /Stuck · nearing lookback/)
	assert.equal(cells.staging.tone, 'bad')
})

test('a revision-0 seed is starting during the window and not started after it', () => {
	const seed: StagingProgressFacts = {
		phase: 'mailbox',
		revision: 0,
		advancedAtMs: null,
		ownerIndex: 0,
	}
	const starting = derive({
		day: today,
		stagingProgress: seed,
		activeStagingDay: today,
	})
	assert.equal(starting.staging.label, 'Starting')
	assert.equal(starting.staging.tone, 'neutral')

	const justBecameHead = derive({
		day: '2026-10-17',
		stagingProgress: seed,
		activeStagingDay: '2026-10-17',
	})
	assert.equal(justBecameHead.staging.label, 'Starting')
	assert.equal(justBecameHead.staging.tone, 'neutral')

	const notTheHead = derive({
		day: '2026-10-17',
		stagingProgress: seed,
		activeStagingDay: null,
	})
	assert.equal(notTheHead.staging.label, 'Not started')
	assert.equal(notTheHead.staging.tone, 'bad')
})

test('a finished day is complete, then waiting, due, or overdue for the hourly seal', () => {
	const recent = derive({
		day: '2026-10-15',
		stagingSummary: { completedAtMs: now.getTime() - 60 * 60_000 },
	})
	assert.equal(recent.staging.label, 'Complete')
	assert.equal(recent.staging.tone, 'ok')
	assert.equal(recent.sealed.label, 'Due (hourly seal)')
	assert.equal(recent.sealed.tone, 'neutral')
	assert.equal(recent.sealVerified.label, 'Waiting')

	const late = derive({
		day: '2026-10-15',
		stagingSummary: { completedAtMs: now.getTime() - 4 * 60 * 60_000 },
	})
	assert.equal(late.sealed.label, 'Overdue')
	assert.equal(late.sealed.tone, 'warn')
	assert.notEqual(late.sealVerified.tone, 'bad')

	const sealed = derive({
		day: '2026-10-13',
		stagingSummary: { completedAtMs: now.getTime() - 24 * 60 * 60_000 },
		seal: 'verified',
	})
	assert.equal(sealed.sealed.label, 'Sealed')
	assert.equal(sealed.sealVerified.label, 'Verified')
	assert.equal(sealed.sealed.tone, 'ok')
})

test('seal failures are the only red seal states', () => {
	const invalid = derive({
		day: '2026-10-13',
		stagingSummary: { completedAtMs: now.getTime() },
		seal: 'invalid',
	})
	assert.equal(invalid.sealed.label, 'Invalid signature')
	assert.equal(invalid.sealVerified.label, 'Invalid')
	assert.equal(invalid.sealed.tone, 'bad')

	const unreadable = derive({
		day: '2026-10-13',
		stagingSummary: { completedAtMs: now.getTime() },
		seal: 'unreadable',
	})
	assert.equal(unreadable.sealed.label, 'Unreadable')
	assert.equal(unreadable.sealVerified.tone, 'bad')

	const badSummary = derive({
		day: '2026-10-13',
		stagingSummary: 'unreadable',
	})
	assert.equal(badSummary.staging.label, 'Unreadable')
	assert.equal(badSummary.sealed.label, 'Waiting for staging')
})

test('progress JSON keeps phase, revision, advance time, and the active lane index', () => {
	const parsed = parseStagingProgressFacts({
		phase: 'mailbox',
		revision: 2645,
		advancedAt: '2026-10-18T03:05:00.000Z',
		leaseExpiresAt: null,
		mailbox: { ownerIndex: 736 },
		runLog: { ownerIndex: 0 },
	})
	assert.deepEqual(parsed, {
		phase: 'mailbox',
		revision: 2645,
		advancedAtMs: Date.parse('2026-10-18T03:05:00.000Z'),
		ownerIndex: 736,
	})

	const fromLease = parseStagingProgressFacts({
		phase: 'run-log',
		revision: 4,
		leaseExpiresAt: '2026-10-18T03:12:00.000Z',
		runLog: { ownerIndex: 12 },
	})
	assert.equal(
		fromLease?.advancedAtMs,
		Date.parse('2026-10-18T03:12:00.000Z') - 2 * 60_000,
	)
	assert.equal(fromLease?.ownerIndex, 12)
	assert.equal(parseStagingProgressFacts({ phase: 'nope' }), null)
	assert.equal(parseStagingProgressFacts(null), null)
})
