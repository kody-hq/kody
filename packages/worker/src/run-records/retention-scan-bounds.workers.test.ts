import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type { RunLog } from './run-log-do.ts'
import { seedRunLogMeta } from './run-log-meta-test-seed.ts'
import {
	beginRunRecord,
	claimPackageInvocationRecord,
	finishPackageInvocationRecord,
	finishRunRecord,
	getSqlBillingStats,
} from './service.ts'
import {
	runRecordMaxRunsPerUser,
	runRecordRetentionMinPassIntervalMs,
} from './types.ts'

const ledgerRows = 20_000
const workflowProjectionRows = 3_000
/** Per-pass budget that does not grow with table size. */
const maxRowsReadPerPass = 500

function runLogStub(userId: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(namespace.idFromName(userId))
}

/** A busy account: full run cap, months of ledger rows, finished workflows. */
async function seedBusyRunLog(userId: string) {
	await runInDurableObject(
		runLogStub(userId),
		async (instance: RunLog, state) => {
			const sql = state.storage.sql
			const now = Date.now()
			const spanMs = 80 * 24 * 60 * 60 * 1000
			for (let index = 0; index < ledgerRows; index += 1) {
				const at = new Date(now - (index / ledgerRows) * spanMs).toISOString()
				sql.exec(
					`INSERT INTO package_invocation_ledger (
					id, token_id, package_id, package_kody_id, export_name,
					idempotency_key, request_hash, status, response_json,
					created_at, updated_at
				) VALUES (?, 'token', 'pkg', 'kody', 'handler', ?, 'hash', ?, '{}', ?, ?)`,
					`ledger-${index}`,
					`key-${index}`,
					index % 50 === 0 ? 'failed' : 'completed',
					at,
					at,
				)
			}
			for (let index = 0; index < runRecordMaxRunsPerUser; index += 1) {
				const at = new Date(now - index * 60_000).toISOString()
				sql.exec(
					`INSERT INTO runs (
					id, surface, status, started_at, finished_at, metadata_json,
					created_at, updated_at
				) VALUES (?, 'execute', 'success', ?, ?, '{}', ?, ?)`,
					`run-${index}`,
					at,
					at,
					at,
					at,
				)
			}
			for (let index = 0; index < workflowProjectionRows; index += 1) {
				const at = new Date(now - index * 600_000).toISOString()
				sql.exec(
					`INSERT INTO workflow_projections (
					id, binding_name, source_type, workflow_name, idempotency_key,
					run_at, status, created_at, updated_at, completed_at
				) VALUES (?, 'BINDING', 'inline', 'flow', ?, ?, 'complete', ?, ?, ?)`,
					`workflow-${index}`,
					`workflow-key-${index}`,
					at,
					at,
					at,
					at,
				)
			}
			seedRunLogMeta(instance, {
				runCount: runRecordMaxRunsPerUser,
				finishesSinceRetention: 0,
			})
		},
	)
}

async function rowsReadDuring(userId: string, work: () => Promise<unknown>) {
	const before = await getSqlBillingStats({
		env,
		userId: ownerIdFromStored(userId),
	})
	await work()
	const after = await getSqlBillingStats({
		env,
		userId: ownerIdFromStored(userId),
	})
	const beforeBySql = new Map(
		before.statements.map((statement) => [statement.sql, statement.rowsRead]),
	)
	const largest = after.statements
		.map((statement) => ({
			sql: statement.sql,
			rowsRead: statement.rowsRead - (beforeBySql.get(statement.sql) ?? 0),
		}))
		.sort((a, b) => b.rowsRead - a.rowsRead)[0]
	return { total: after.rowsReadTotal - before.rowsReadTotal, largest }
}

test('retention passes and hot writes read a bounded number of rows on a busy RunLog', async () => {
	const userId = 'retention-scan-bounds'
	await seedBusyRunLog(userId)
	const owner = ownerIdFromStored(userId)

	const alarmPass = await rowsReadDuring(userId, () =>
		runInDurableObject(runLogStub(userId), (instance: RunLog) =>
			instance.alarm(),
		),
	)
	expect(alarmPass.total).toBeLessThan(maxRowsReadPerPass)

	const finish = await rowsReadDuring(userId, () =>
		finishRunRecord({
			env,
			handle: beginRunRecord({
				env,
				userId: owner,
				context: { surface: 'execute', name: 'bounded' },
			}),
			status: 'success',
		}),
	)
	expect(finish.total).toBeLessThan(maxRowsReadPerPass)

	const invocation = await rowsReadDuring(userId, async () => {
		const claimed = await claimPackageInvocationRecord({
			env,
			userId: owner,
			context: {
				surface: 'export',
				packageId: 'pkg',
				name: 'handler',
				idempotencyKey: 'fresh-key',
			},
			invocation: {
				id: crypto.randomUUID(),
				tokenId: 'token',
				packageId: 'pkg',
				packageKodyId: 'kody',
				exportName: 'handler',
				idempotencyKey: 'fresh-key',
				requestHash: 'hash',
				source: null,
				topic: null,
			},
			staleBefore: new Date(0).toISOString(),
		})
		if (claimed.outcome !== 'claimed') throw new Error('expected a claim')
		await finishPackageInvocationRecord({
			env,
			userId: owner,
			handle: claimed.handle,
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			ledgerStatus: 'completed',
			responseJson: '{}',
			status: 'success',
		})
	})
	expect(invocation.total).toBeLessThan(maxRowsReadPerPass)
})

test('a retention pass never schedules the next one sooner than the pass interval', async () => {
	const userId = 'retention-pass-interval'
	await seedBusyRunLog(userId)
	await runInDurableObject(
		runLogStub(userId),
		async (instance: RunLog, state) => {
			const passStartedAt = Date.now()
			await instance.alarm()
			// Over the cap again: the next run wants an immediate eviction pass.
			await finishRunRecord({
				env,
				handle: beginRunRecord({
					env,
					userId: ownerIdFromStored(userId),
					context: { surface: 'execute', name: 'over-cap' },
				}),
				status: 'success',
			})
			const alarmAt = await state.storage.getAlarm()
			expect(alarmAt).not.toBeNull()
			expect(alarmAt!).toBeGreaterThanOrEqual(
				passStartedAt + runRecordRetentionMinPassIntervalMs,
			)
		},
	)
})
