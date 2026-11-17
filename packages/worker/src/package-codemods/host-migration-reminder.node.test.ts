import { expect, test, vi } from 'vitest'
import { getScheduledLaneCadence } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	packageAppHostMigrationReminderKvKey,
	runPackageAppHostMigrationReminder,
} from './host-migration-reminder.ts'

const lane = 'package_app_host_migration_reminder'

function setup(input: { enabled?: string } = {}) {
	const { kv } = createMemoryKvNamespace()
	const env = {
		BUNDLE_ARTIFACTS_KV: kv,
		APP_BASE_URL: 'https://kody.test',
		PACKAGE_APP_HOST_MIGRATION_REMINDER_ENABLED: input.enabled ?? 'true',
	} as unknown as Env
	// Two scan pages, then two notice pages.
	const scanStep = vi
		.fn()
		.mockResolvedValueOnce({ runId: 'fresh-run', nextCursor: 'scan-2' })
		.mockResolvedValueOnce({ runId: 'fresh-run', nextCursor: null })
	const sendNotice = vi
		.fn()
		.mockResolvedValueOnce({ summary: { sent: 5 }, nextCursor: 'owner-5' })
		.mockResolvedValueOnce({
			summary: { sent: 2, already_sent: 1 },
			nextCursor: null,
		})
	const run = (now: string, clock?: () => number) =>
		runPackageAppHostMigrationReminder({
			env,
			now: new Date(now),
			scanStep,
			sendNotice,
			...(clock ? { clock } : {}),
		})
	return { kv, scanStep, sendNotice, run }
}

test('the lane is dispatched only from December 3, 2026 for one week', () => {
	const at = (iso: string) => getScheduledLaneCadence(new Date(iso))
	expect(at('2026-12-02T23:55:00Z')).not.toContain(lane)
	expect(at('2026-12-03T00:00:00Z')).toContain(lane)
	expect(at('2026-12-09T23:55:00Z')).toContain(lane)
	expect(at('2026-12-10T00:00:00Z')).not.toContain(lane)
})

test('nothing runs before December 3 or where the reminder is not enabled', async () => {
	const early = setup()
	expect(await early.run('2026-12-02T23:59:59Z')).toBeNull()
	const disabled = setup({ enabled: '' })
	expect(await disabled.run('2026-12-03T16:00:00Z')).toBeNull()
	const late = setup()
	expect(await late.run('2026-12-10T00:00:00Z')).toBeNull()
	for (const { scanStep, sendNotice } of [early, disabled, late]) {
		expect(scanStep).not.toHaveBeenCalled()
		expect(sendNotice).not.toHaveBeenCalled()
	}
})

test('a fresh scan runs first and no mail goes out before 15:00 UTC', async () => {
	const { scanStep, sendNotice, run } = setup()

	const morning = await run('2026-12-03T00:00:00Z')
	expect(scanStep).toHaveBeenCalledTimes(2)
	// The first step starts a new run; the second continues it.
	expect(scanStep.mock.calls[0]![0]).not.toHaveProperty('runId')
	expect(scanStep.mock.calls[0]![0]).toMatchObject({
		codemodId: '0019-detect-package-app-host-migration',
		mode: 'scan',
		scope: { kind: 'fleet' },
	})
	expect(scanStep.mock.calls[1]![0]).toMatchObject({
		runId: 'fresh-run',
		cursor: 'scan-2',
	})
	expect(morning).toMatchObject({ scanDone: true, done: false })
	expect(sendNotice).not.toHaveBeenCalled()

	await run('2026-12-03T14:55:00Z')
	expect(sendNotice).not.toHaveBeenCalled()

	const sent = await run('2026-12-03T15:00:00Z')
	expect(scanStep).toHaveBeenCalledTimes(2)
	expect(sendNotice).toHaveBeenCalledTimes(2)
	expect(sendNotice.mock.calls[0]![0]).toMatchObject({
		runId: 'fresh-run',
		noticeId: 'host-migration-reminder',
		kind: 'reminder',
		cutoverDate: 'December 17, 2026',
		reminderDate: 'December 3, 2026',
		dryRun: false,
		cursor: null,
	})
	expect(sendNotice.mock.calls[1]![0]).toMatchObject({ cursor: 'owner-5' })
	expect(sent).toMatchObject({
		done: true,
		sent: { sent: 7, already_sent: 1 },
	})
})

test('once done, later ticks do nothing', async () => {
	const { scanStep, sendNotice, run } = setup()
	await run('2026-12-03T15:00:00Z')
	const later = await run('2026-12-03T15:05:00Z')
	expect(later?.done).toBe(true)
	expect(scanStep).toHaveBeenCalledTimes(2)
	expect(sendNotice).toHaveBeenCalledTimes(2)
})

test('a tick that runs out of time or fails resumes from the saved cursor', async () => {
	const { kv, scanStep, sendNotice, run } = setup()
	// Each clock read is 30 s later, so the 40 s budget allows one page.
	let elapsed = 0
	const slowClock = () => (elapsed += 30_000)

	await run('2026-12-03T15:00:00Z', slowClock)
	expect(scanStep).toHaveBeenCalledTimes(1)
	expect(
		await kv.get(packageAppHostMigrationReminderKvKey, 'json'),
	).toMatchObject({
		scanRunId: 'fresh-run',
		scanCursor: 'scan-2',
		scanDone: false,
	})

	await run('2026-12-03T15:05:00Z')
	expect(scanStep).toHaveBeenCalledTimes(2)
	expect(sendNotice).toHaveBeenCalledTimes(2)

	const failing = setup()
	failing.sendNotice.mockReset()
	failing.sendNotice
		.mockRejectedValueOnce(new Error('mail provider down'))
		.mockResolvedValueOnce({ summary: { sent: 3 }, nextCursor: null })
	await expect(failing.run('2026-12-03T15:00:00Z')).rejects.toThrow(
		'mail provider down',
	)
	const retried = await failing.run('2026-12-03T15:05:00Z')
	// The scan is not repeated; the claim in the notice keeps the retry safe.
	expect(failing.scanStep).toHaveBeenCalledTimes(2)
	expect(retried).toMatchObject({ done: true, sent: { sent: 3 } })
})
