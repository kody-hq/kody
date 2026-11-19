import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import type { RunLog } from './run-log-do.ts'
import { ensureRunRecordStarted, getRunRecord } from './service.ts'
import {
	runRecordPlatformInterruptedErrorName,
	runRecordStaleRunningTtlMsShortLived,
	type RunRecordHandle,
} from './types.ts'

const iso = (ms: number) => new Date(ms).toISOString()

function runLogStub(userId: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(namespace.idFromName(userId))
}

function executeHandle(userId: string, id: string): RunRecordHandle {
	return {
		id,
		userId: ownerIdFromStored(userId),
		// Older than the 3-minute execute TTL, like a long run on a context.
		startedAt: iso(Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000),
		persistence: 'eager',
		context: { surface: 'execute', name: null },
	}
}

test('a held execute run stays running past the execute TTL until its stale_after', async () => {
	const userId = `stale-hold-${crypto.randomUUID()}`
	const held = executeHandle(userId, 'held-run')
	const lapsed = executeHandle(userId, 'lapsed-run')
	const plain = executeHandle(userId, 'plain-run')
	const heldUntil = Date.now() + 10 * 60_000
	expect(
		await ensureRunRecordStarted({
			env,
			handle: held,
			staleAfter: iso(heldUntil),
		}),
	).toBe(true)
	await ensureRunRecordStarted({
		env,
		handle: lapsed,
		staleAfter: iso(Date.now() - 1_000),
	})
	await ensureRunRecordStarted({ env, handle: plain })

	// The alarm's reconcile pass leaves the held row alone.
	await runInDurableObject(runLogStub(userId), async (instance: RunLog) => {
		await instance.alarm()
	})
	const read = (runId: string) =>
		getRunRecord({ env, userId: ownerIdFromStored(userId), runId })
	expect((await read('held-run'))?.run).toMatchObject({
		status: 'running',
		finishedAt: null,
	})
	for (const runId of ['lapsed-run', 'plain-run']) {
		expect((await read(runId))?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
		})
	}

	// The next wake is the held row's stale_after, not an immediate retry.
	const alarmAt = await runInDurableObject(
		runLogStub(userId),
		async (_instance: RunLog, state) => await state.storage.getAlarm(),
	)
	expect(alarmAt).toBe(heldUntil)

	// Once stale_after passes, reading the row heals it as before.
	await runInDurableObject(
		runLogStub(userId),
		async (_instance: RunLog, state) => {
			state.storage.sql.exec(
				`UPDATE runs SET stale_after = ? WHERE id = 'held-run'`,
				iso(Date.now() - 1_000),
			)
		},
	)
	expect((await read('held-run'))?.run).toMatchObject({
		status: 'error',
		errorName: runRecordPlatformInterruptedErrorName,
	})
})
