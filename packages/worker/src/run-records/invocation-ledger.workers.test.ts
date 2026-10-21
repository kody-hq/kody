import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { RunLog } from './run-log-do.ts'
import { seedRunLogMeta } from './run-log-meta-test-seed.ts'
import {
	claimPackageInvocationRecord,
	clearRunRecords,
	exportRunRecords,
	finishPackageInvocationRecord,
	getPackageInvocationRecord,
	getRunRecord,
	releasePackageInvocationRecord,
} from './service.ts'
import {
	packageInvocationLedgerRetentionDays,
	runRecordPlatformInterruptedErrorName,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMsShortLived,
	type RunRecordContext,
} from './types.ts'

function uniqueUserId(label: string): OwnerId {
	return ownerIdFromStored(`invocation-ledger-${label}-${crypto.randomUUID()}`)
}

function runLogStub(userId: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(namespace.idFromName(userId))
}

function ledgerKey(overrides?: Partial<Record<string, string>>) {
	return {
		tokenId: overrides?.tokenId ?? 'token-1',
		packageId: overrides?.packageId ?? 'pkg-1',
		exportName: overrides?.exportName ?? './send-message',
		idempotencyKey: overrides?.idempotencyKey ?? 'evt-1',
	}
}

function claimInput(overrides?: Partial<Record<string, string | null>>) {
	return {
		id: String(overrides?.id ?? crypto.randomUUID()),
		tokenId: String(overrides?.tokenId ?? 'token-1'),
		packageId: String(overrides?.packageId ?? 'pkg-1'),
		packageKodyId: String(overrides?.packageKodyId ?? 'pkg-one'),
		exportName: String(overrides?.exportName ?? './send-message'),
		idempotencyKey: String(overrides?.idempotencyKey ?? 'evt-1'),
		requestHash: String(overrides?.requestHash ?? 'hash-1'),
		source: overrides?.source === undefined ? 'webhook' : overrides.source,
		topic: overrides?.topic === undefined ? null : overrides.topic,
		...(overrides && 'claimOwner' in overrides
			? { claimOwner: overrides.claimOwner }
			: {}),
	}
}

function exportContext(
	overrides?: Partial<RunRecordContext>,
): RunRecordContext {
	return {
		surface: 'export',
		name: './send-message',
		idempotencyKey: 'evt-1',
		metadata: { exportName: './send-message' },
		...overrides,
	}
}

function freshStaleBefore() {
	return new Date(Date.now() - 15 * 60 * 1000).toISOString()
}

type ClaimOverrides = Parameters<typeof claimInput>[0]

function claimRaw(
	userId: string,
	idempotencyKey: string,
	invocation?: ClaimOverrides,
	context: RunRecordContext | null = exportContext({ idempotencyKey }),
) {
	const nowMs = Date.now()
	return claimPackageInvocationRecord({
		env,
		userId: ownerIdFromStored(userId),
		context,
		invocation: claimInput({ idempotencyKey, ...invocation }),
		staleBefore: freshStaleBefore(),
		sameOwnerStaleBefore: new Date(nowMs - 60_000).toISOString(),
	})
}

async function claim(...args: Parameters<typeof claimRaw>) {
	const claimed = await claimRaw(...args)
	if (claimed.outcome !== 'claimed') throw new Error('Expected fresh claim.')
	return claimed
}

type Claimed = Awaited<ReturnType<typeof claim>>

function finish(
	userId: string,
	claimed: Pick<Claimed, 'handle' | 'invocationId' | 'claimUpdatedAt'>,
	outcome: Partial<Parameters<typeof finishPackageInvocationRecord>[0]> = {},
) {
	return finishPackageInvocationRecord({
		env,
		userId: ownerIdFromStored(userId),
		handle: claimed.handle,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson: JSON.stringify({ status: 200, body: { ok: true } }),
		status: 'success',
		...outcome,
	})
}

const failedOutcome = (message: string) =>
	({
		ledgerStatus: 'failed',
		responseJson: JSON.stringify({ status: 500, body: { ok: false } }),
		status: 'error',
		error: new Error(message),
	}) as const

function getLedger(userId: string, idempotencyKey: string) {
	return getPackageInvocationRecord({
		env,
		userId: ownerIdFromStored(userId),
		key: ledgerKey({ idempotencyKey }),
	})
}

function getRun(userId: string, runId: string) {
	return getRunRecord({ env, userId: ownerIdFromStored(userId), runId })
}

async function sqlExec(
	userId: string,
	query: string,
	...bindings: Array<SqlStorageValue>
) {
	const stub = runLogStub(userId)
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		state.storage.sql.exec(query, ...bindings)
	})
}

/** Backdates a running row past the short-lived stale TTL. */
async function backdateRunningRow(
	userId: string,
	runId: string,
	extraMs: number,
) {
	const staleStartedAt = new Date(
		Date.now() - runRecordStaleRunningTtlMsShortLived - extraMs,
	).toISOString()
	await sqlExec(
		userId,
		`UPDATE runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?`,
		staleStartedAt,
		staleStartedAt,
		staleStartedAt,
		runId,
	)
	return staleStartedAt
}

test('claim + finish journey: one call each, replay record, run row lifecycle', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('journey')

	const claimed = await claim(userId, 'evt-1')
	expect(claimed.reclaimed).toBe(false)
	if (!claimed.handle) throw new Error('Expected an eager run handle.')

	// The eager running row landed in the same DO call as the ledger claim.
	expect((await getRun(userId, claimed.handle.id))?.run).toMatchObject({
		status: 'running',
		surface: 'export',
		idempotencyKey: 'evt-1',
		invocationId: claimed.invocationId,
	})

	// A duplicate claim sees the in-progress owner instead of double-claiming.
	const duplicate = await claimRaw(userId, 'evt-1')
	expect(duplicate.outcome).toBe('existing')
	if (duplicate.outcome !== 'existing') throw new Error('unreachable')
	expect(duplicate.record).toMatchObject({
		id: claimed.invocationId,
		status: 'in_progress',
		requestHash: 'hash-1',
	})

	const responseJson = JSON.stringify({
		status: 200,
		body: { ok: true, result: { sent: true } },
	})
	expect(
		await finish(userId, claimed, {
			responseJson,
			logs: ['sent'],
			result: { sent: true },
		}),
	).toMatchObject({ ledgerUpdated: true, record: null })

	expect(await getLedger(userId, 'evt-1')).toMatchObject({
		id: claimed.invocationId,
		status: 'completed',
		responseJson,
	})
	// The terminal run row (with logs and result snapshot) landed in the same
	// DO call as the ledger response.
	const terminalRun = await getRun(userId, claimed.handle.id)
	expect(terminalRun?.run).toMatchObject({
		status: 'success',
		invocationId: claimed.invocationId,
		metadata: expect.objectContaining({ result: { sent: true } }),
	})
	expect(terminalRun?.logs.map((log) => log.message)).toEqual(['sent'])
})

test('late failed subscription finish reopens a system-ignored platform interrupt', async () => {
	const userId = uniqueUserId('late-subscription-failure')
	const idempotencyKey = 'delivery-late-failure'
	const claimed = await claim(
		userId,
		idempotencyKey,
		{},
		exportContext({
			surface: 'subscription',
			name: 'email.message.received',
			idempotencyKey,
		}),
	)
	if (!claimed.handle) throw new Error('Expected a fresh subscription claim.')
	const runId = claimed.handle.id
	const staleStartedAt = await backdateRunningRow(userId, runId, 1_000)

	expect((await getRun(userId, runId))?.run).toMatchObject({
		status: 'error',
		errorName: runRecordPlatformInterruptedErrorName,
		errorTriage: 'ignored',
		triagedBy: 'system:platform-interrupt',
	})

	const finished = await finish(
		userId,
		{ ...claimed, handle: { ...claimed.handle, startedAt: staleStartedAt } },
		{
			ledgerStatus: 'failed',
			responseJson: JSON.stringify({
				status: 500,
				body: { error: 'known package failure' },
			}),
			status: 'error',
			error: new Error('known package failure'),
		},
	)
	expect(finished.ledgerUpdated).toBe(true)
	expect((await getRun(userId, runId))?.run).toMatchObject({
		status: 'error',
		errorName: 'Error',
		errorMessage: 'known package failure',
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
	})
})

test('same claimOwner reclaims after the same-owner grace; a different owner does not', async () => {
	const userId = uniqueUserId('same-owner-reclaim')
	const deliveryOwner = 'delivery-ack-1'
	const seeded = await claim(userId, 'evt-owner', { claimOwner: deliveryOwner })
	expect(await getLedger(userId, 'evt-owner')).toMatchObject({
		status: 'in_progress',
		claimOwner: deliveryOwner,
	})

	// Owner equality alone must not steal a brand-new claim (protects a
	// failed terminal persist from immediate re-execution on the next retry).
	const tooFresh = await claimRaw(userId, 'evt-owner', {
		claimOwner: deliveryOwner,
	})
	expect(tooFresh.outcome).toBe('existing')

	// A distinct delivery with the same idempotency key must still see
	// invocation_in_progress (dedupe), not steal the claim.
	const otherDelivery = await claimRaw(userId, 'evt-owner', {
		claimOwner: 'delivery-ack-2',
	})
	expect(otherDelivery.outcome).toBe('existing')
	if (otherDelivery.outcome !== 'existing') throw new Error('unreachable')
	expect(otherDelivery.record).toMatchObject({
		id: seeded.invocationId,
		status: 'in_progress',
		claimOwner: deliveryOwner,
	})

	// Past the same-owner grace (60s) but still inside the 15-minute global
	// stale window: the ack queue retry of this delivery can take over.
	const graceUpdatedAt = new Date(Date.now() - 61_000).toISOString()
	await sqlExec(
		userId,
		`UPDATE package_invocation_ledger SET updated_at = ? WHERE id = ?`,
		graceUpdatedAt,
		seeded.invocationId,
	)
	const retried = await claim(userId, 'evt-owner', {
		claimOwner: deliveryOwner,
	})
	expect(retried).toMatchObject({
		invocationId: seeded.invocationId,
		reclaimed: true,
	})
	expect(retried.claimUpdatedAt > graceUpdatedAt).toBe(true)
	expect(await getLedger(userId, 'evt-owner')).toMatchObject({
		status: 'in_progress',
		claimOwner: deliveryOwner,
		updatedAt: retried.claimUpdatedAt,
	})

	const finished = await finish(
		userId,
		retried,
		failedOutcome('retry after hung first attempt'),
	)
	expect(finished.ledgerUpdated).toBe(true)
	expect((await getLedger(userId, 'evt-owner'))?.status).toBe('failed')
})

test('stale in-progress claims are reclaimed atomically; mismatched hashes are not', async () => {
	const userId = uniqueUserId('stale-reclaim')
	const seeded = await claim(userId, 'evt-stale')
	// Backdate the claim so it is past the 15-minute stale window.
	const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString()
	await sqlExec(
		userId,
		`UPDATE package_invocation_ledger SET updated_at = ? WHERE id = ?`,
		staleUpdatedAt,
		seeded.invocationId,
	)

	// A different request hash never reclaims (mismatch resolution owns it).
	const mismatch = await claimRaw(userId, 'evt-stale', {
		requestHash: 'other-hash',
	})
	expect(mismatch.outcome).toBe('existing')

	const reclaimed = await claim(userId, 'evt-stale')
	expect(reclaimed).toMatchObject({
		invocationId: seeded.invocationId,
		reclaimed: true,
	})
	expect(reclaimed.claimUpdatedAt > staleUpdatedAt).toBe(true)

	// The superseded attempt's finish is fenced out of the ledger but its own
	// run row still lands terminal.
	const staleAttemptHandle = {
		id: crypto.randomUUID(),
		userId,
		startedAt: new Date().toISOString(),
		persistence: 'eager' as const,
		context: exportContext({ idempotencyKey: 'evt-stale' }),
	}
	const fenced = await finish(
		userId,
		{
			handle: staleAttemptHandle,
			invocationId: seeded.invocationId,
			claimUpdatedAt: staleUpdatedAt,
		},
		failedOutcome('superseded attempt'),
	)
	expect(fenced.ledgerUpdated).toBe(false)
	expect(fenced.record).toMatchObject({
		id: seeded.invocationId,
		status: 'in_progress',
		updatedAt: reclaimed.claimUpdatedAt,
	})
	expect((await getRun(userId, staleAttemptHandle.id))?.run.status).toBe(
		'error',
	)

	// The reclaiming attempt finishes normally.
	const finished = await finish(
		userId,
		reclaimed,
		failedOutcome('handler failed'),
	)
	expect(finished.ledgerUpdated).toBe(true)
	expect((await getLedger(userId, 'evt-stale'))?.status).toBe('failed')
})

test('release frees the in-progress claim and finishes the running row as error so retries keep evidence', async () => {
	const userId = uniqueUserId('release')
	const claimed = await claim(userId, 'evt-release')

	const released = await releasePackageInvocationRecord({
		env,
		userId,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		handle: claimed.handle,
		error: {
			name: 'artifact_preparation_failed',
			message: 'Package artifact preparation failed before execution.',
		},
		logs: [
			'package invocation started: ./handler',
			{
				level: 'error',
				message: 'Package artifact preparation failed before execution.',
			},
		],
	})
	expect(released).toMatchObject({ released: true, record: null })
	expect(await getLedger(userId, 'evt-release')).toBeNull()
	const finishedRun = await getRun(userId, claimed.handle!.id)
	expect(finishedRun?.run).toMatchObject({
		status: 'error',
		errorName: 'artifact_preparation_failed',
	})
	expect(finishedRun?.run.logCount).toBeGreaterThan(0)
	expect(
		finishedRun?.logs.some((log) => /artifact preparation/i.test(log.message)),
	).toBe(true)

	// A stale release token cannot delete a newer claim; the caller gets the
	// current owner back instead.
	const second = await claim(userId, 'evt-release')
	const fencedRelease = await releasePackageInvocationRecord({
		env,
		userId,
		invocationId: second.invocationId,
		claimUpdatedAt: new Date(0).toISOString(),
		handle: null,
	})
	expect(fencedRelease.released).toBe(false)
	expect(fencedRelease.record).toMatchObject({
		id: second.invocationId,
		status: 'in_progress',
	})
})

test('DO-local retention prunes terminal ledger rows after 90 days and keeps in-progress rows', async () => {
	const userId = uniqueUserId('retention')
	const expiredCreatedAt = new Date(
		Date.now() -
			(packageInvocationLedgerRetentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	for (const [id, idempotencyKey, status, createdAt] of [
		['expired-terminal', 'evt-expired', 'completed', expiredCreatedAt],
		[
			'expired-in-progress',
			'evt-expired-open',
			'in_progress',
			expiredCreatedAt,
		],
		['recent-terminal', 'evt-recent', 'completed', new Date().toISOString()],
	] as const) {
		await sqlExec(
			userId,
			`INSERT INTO package_invocation_ledger (
				id, token_id, package_id, package_kody_id, export_name,
				idempotency_key, request_hash, source, topic, status,
				response_json, created_at, updated_at
			) VALUES (?, 'token-1', 'pkg-1', 'pkg-one', './send-message', ?, 'hash-1',
				NULL, NULL, ?, NULL, ?, ?)`,
			id,
			idempotencyKey,
			status,
			createdAt,
			createdAt,
		)
	}

	// Arm retention so the next finish runs a full pass.
	const stub = runLogStub(userId)
	await runInDurableObject(stub, async (instance: RunLog) => {
		seedRunLogMeta(instance, {
			finishesSinceRetention: runRecordRetentionEveryNFinishes - 1,
		})
	})
	const claimed = await claim(userId, 'evt-trigger', {}, null)
	await finish(userId, claimed, { handle: null, responseJson: null })

	expect(await getLedger(userId, 'evt-expired')).toBeNull()
	expect(await getLedger(userId, 'evt-expired-open')).toMatchObject({
		id: 'expired-in-progress',
		status: 'in_progress',
	})
	expect(await getLedger(userId, 'evt-recent')).toMatchObject({
		id: 'recent-terminal',
		status: 'completed',
	})
})

test('account export pages runs first, then ledger rows, through one cursor; clearAll purges both', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('export')
	for (const key of ['evt-a', 'evt-b', 'evt-c']) {
		await finish(userId, await claim(userId, key))
	}

	const seenRunIds = new Set<string>()
	const seenLedgerIds = new Set<string>()
	let startAfter: string | null = null
	for (let page = 0; page < 10; page += 1) {
		const exported = await exportRunRecords({
			env,
			userId,
			pageSize: 2,
			startAfter,
		})
		for (const run of exported.runs) seenRunIds.add(run.id)
		for (const row of exported.packageInvocations) seenLedgerIds.add(row.id)
		if (!exported.truncated) break
		startAfter = exported.nextStartAfter
	}
	expect(seenRunIds.size).toBe(3)
	expect(seenLedgerIds.size).toBe(3)

	await clearRunRecords({ env, userId })
	expect(await exportRunRecords({ env, userId, pageSize: 10 })).toMatchObject({
		runs: [],
		packageInvocations: [],
		truncated: false,
	})
	expect(await getLedger(userId, 'evt-a')).toBeNull()
})

test('a keyed package invocation keeps its started log when the running row is later interrupted', async () => {
	const userId = uniqueUserId('started-log')
	const idempotencyKey = 'audit-listupcoming'
	const claimed = await claim(
		userId,
		idempotencyKey,
		{ exportName: './list-upcoming' },
		exportContext({ name: 'listUpcoming', idempotencyKey }),
	)
	if (!claimed.handle) throw new Error('expected a claimed package invocation')
	const runId = claimed.handle.id
	const startedLog = ['package invocation started: listUpcoming']
	const running = await getRun(userId, runId)
	expect(running?.run.status).toBe('running')
	expect(running?.logs.map((entry) => entry.message)).toEqual(startedLog)

	await backdateRunningRow(userId, runId, 5_000)
	const interrupted = await getRun(userId, runId)
	expect(interrupted?.run).toMatchObject({
		status: 'error',
		errorName: runRecordPlatformInterruptedErrorName,
	})
	expect(interrupted?.logs.map((entry) => entry.message)).toEqual(startedLog)
})
