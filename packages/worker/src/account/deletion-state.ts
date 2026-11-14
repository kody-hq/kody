/**
 * soft-delete-read-filter: opt-out
 *
 * Write-lease gates must see soft-deleted `users` rows so a tombstoned person
 * is never mistaken for a team org OwnerId (personal orgs reuse stable_user_id).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import * as Sentry from '@sentry/cloudflare'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
	type UserMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	accountWriteLeaseHeartbeatMs,
	staleBlockingAccountWriteLeaseMs,
	writeLeaseTtlMs,
} from './write-lease-timing.ts'
import { runWithTransientDurableObjectResetRetry } from '#worker/durable-object-reset-retry.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export class AccountDeletionInProgressError extends Error {
	constructor() {
		super('Account deletion is in progress; user-owned writes are disabled.')
		this.name = 'AccountDeletionInProgressError'
	}
}

export type BlockingAccountWriteLease = { holder: string; acquiredAt: string }

function blockingAccountWriteLeaseAgeMs(
	lease: BlockingAccountWriteLease,
	nowMs: number,
) {
	const acquiredAt = lease.acquiredAt.includes('T')
		? lease.acquiredAt
		: `${lease.acquiredAt.replace(' ', 'T')}Z`
	const acquiredMs = Date.parse(acquiredAt)
	return Number.isFinite(acquiredMs) ? Math.max(0, nowMs - acquiredMs) : null
}

function describeBlockingAccountWriteLease(
	lease: BlockingAccountWriteLease,
	nowMs: number,
) {
	const ageMs = blockingAccountWriteLeaseAgeMs(lease, nowMs)
	return ageMs == null
		? lease.holder
		: `${lease.holder} (started ${Math.round(ageMs / 1000)}s ago)`
}

/**
 * Deletion refused because writes are still running. This is a conflict the
 * caller resolves by retrying, so it is a caller error, not a server fault.
 */
export class AccountDeletionWritersActiveError extends McpCallerError {
	readonly activeWriteCount: number
	readonly blockingLeases: ReadonlyArray<BlockingAccountWriteLease>

	constructor(
		activeWriteCount: number,
		blockingLeases: ReadonlyArray<BlockingAccountWriteLease> = [],
		nowMs = Date.now(),
	) {
		const named = blockingLeases
			.map((lease) => describeBlockingAccountWriteLease(lease, nowMs))
			.join(', ')
		const unnamed = activeWriteCount - blockingLeases.length
		const holders =
			named.length === 0
				? ''
				: ` Held by: ${named}${unnamed > 0 ? `, and ${unnamed} more` : ''}.`
		super(
			`Deletion is waiting for ${activeWriteCount} write(s) on this account to finish.${holders} Nothing was deleted. Retry in a few seconds; a write that stopped without finishing stops blocking within ${Math.round(writeLeaseTtlMs / 60_000)} minutes.`,
		)
		this.name = 'AccountDeletionWritersActiveError'
		this.activeWriteCount = activeWriteCount
		this.blockingLeases = blockingLeases
	}
}

/**
 * The refusal to throw for a fenced deletion with active writers. A short
 * wait is routine; a lease that is still renewing after minutes is a writer
 * that will not finish, which operators need to hear about.
 */
export function accountDeletionWritersActive(
	marked: {
		leaseCount: number
		blockingLeases?: ReadonlyArray<BlockingAccountWriteLease>
	},
	nowMs = Date.now(),
) {
	const error = new AccountDeletionWritersActiveError(
		marked.leaseCount,
		marked.blockingLeases ?? [],
		nowMs,
	)
	const stale = error.blockingLeases.flatMap((lease) => {
		const ageMs = blockingAccountWriteLeaseAgeMs(lease, nowMs)
		return ageMs != null && ageMs >= staleBlockingAccountWriteLeaseMs
			? [{ holder: lease.holder, ageSeconds: Math.round(ageMs / 1000) }]
			: []
	})
	if (stale.length > 0) {
		Sentry.withScope((scope) => {
			scope.setLevel('warning')
			scope.setFingerprint(['account-write-lease-stuck'])
			scope.setContext('account_write_leases', { stale })
			Sentry.captureMessage(
				`Account write lease still held after ${Math.round(staleBlockingAccountWriteLeaseMs / 60_000)} minutes: ${stale.map((lease) => lease.holder).join(', ')}.`,
			)
		})
	}
	return error
}

export class AccountWriteLeaseLostError extends Error {
	constructor() {
		super('Account write lease was released before the operation completed.')
		this.name = 'AccountWriteLeaseLostError'
	}
}

export type AccountWriteLease = {
	token: string
	stableUserId: OwnerId
	holder: string
	acquiredAt: string
}

type ListedAccountWriteLease = {
	token: string
	holder: string
	acquired_at: string
}

function requireUserMeterEnv(env: UserMeterEnv) {
	if (!userMeterNamespace(env)) {
		throw new Error('USER_METER Durable Object binding is not configured.')
	}
	return env
}

async function runUserMeterRpc<T>(input: {
	env: UserMeterEnv
	stableUserId: OwnerId
	operation: (meter: UserMeterRpc) => Promise<T>
}) {
	return await runWithTransientDurableObjectResetRetry({
		operation: async () =>
			await input.operation(
				userMeterRpc({
					env: input.env,
					userId: input.stableUserId,
				}),
			),
	})
}

async function insertOrVerifyDoRepairAudit(input: {
	db: D1Database
	repairId: string
	stableUserId: OwnerId
	token: string
	holder: string
	acquiredAt: string
	repairedByUserId: string
	reason: string
	now: string
}) {
	const inserted = await input.db
		.prepare(
			`INSERT OR IGNORE INTO account_write_lease_repairs (
				id, target_user_id, lease_token, lease_holder,
				lease_acquired_at, repaired_by_user_id, reason, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.repairId,
			input.stableUserId,
			input.token,
			input.holder,
			input.acquiredAt,
			input.repairedByUserId,
			input.reason,
			input.now,
		)
		.run()
	if ((inserted.meta.changes ?? 0) === 1) return
	const existing = await input.db
		.prepare(
			`SELECT target_user_id, lease_token, lease_holder, lease_acquired_at,
				repaired_by_user_id, reason
			FROM account_write_lease_repairs
			WHERE id = ?`,
		)
		.bind(input.repairId)
		.first<{
			target_user_id: string
			lease_token: string
			lease_holder: string
			lease_acquired_at: string
			repaired_by_user_id: string
			reason: string
		}>()
	if (
		!existing ||
		existing.target_user_id !== input.stableUserId ||
		existing.lease_token !== input.token ||
		existing.lease_holder !== input.holder ||
		existing.lease_acquired_at !== input.acquiredAt ||
		existing.repaired_by_user_id !== input.repairedByUserId ||
		existing.reason !== input.reason
	) {
		throw new Error('Active account write lease did not match repair request.')
	}
}

async function findMatchingRepairAudit(input: {
	db: D1Database
	stableUserId: OwnerId
	token: string
	expectedAcquiredAt: string
	repairedByUserId: string
	reason: string
}) {
	return await input.db
		.prepare(
			`SELECT id
			FROM account_write_lease_repairs
			WHERE target_user_id = ?
				AND lease_token = ?
				AND lease_acquired_at = ?
				AND repaired_by_user_id = ?
				AND reason = ?
			ORDER BY created_at DESC, id DESC
			LIMIT 1`,
		)
		.bind(
			input.stableUserId,
			input.token,
			input.expectedAcquiredAt,
			input.repairedByUserId,
			input.reason,
		)
		.first<{ id: string }>()
}

export type MarkAccountDeletingResult = {
	leaseCount: number
	blockingLeases: Array<BlockingAccountWriteLease>
	/** True when this invocation wrote `users.deleting_at`. */
	created: boolean
	deletingAt: string
}

export async function markAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
	env: UserMeterEnv
}): Promise<MarkAccountDeletingResult> {
	// D1 deleting_at is set first: it is the permanent point gate and must be
	// written before any UserMeter call so the gate is never missed even if
	// the DO call subsequently fails. Only roll back a tombstone this
	// invocation created (`WHERE deleting_at IS NULL`) so a concurrent or
	// retrying delete cannot wipe another attempt's fence.
	const now = utcSqliteTimestamp(input.now ?? new Date())
	const createResult = await input.db
		.prepare(
			`UPDATE users
			SET deleting_at = ?, updated_at = ?
			WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(now, now, input.dbUserId)
		.run()
	const created = (createResult.meta.changes ?? 0) === 1
	const userRow = await input.db
		.prepare(
			`SELECT stable_user_id, deleting_at
			FROM users
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.dbUserId)
		.first<{ stable_user_id: OwnerId; deleting_at: string | null }>()
	const stableUserId = userRow?.stable_user_id
	const deletingAt = userRow?.deleting_at
	if (!stableUserId || !deletingAt) {
		throw new Error('Account could not be marked for deletion.')
	}
	// Invalidate before the UserMeter RPC so same-isolate package-app serve
	// cannot keep using the pre-fence cached row for the duration of that call.
	invalidatePackageAppOwnerCache({ stableUserId })
	try {
		const env = requireUserMeterEnv(input.env)
		const marked = await runUserMeterRpc({
			env,
			stableUserId,
			operation: async (meter) => await meter.markDeleting({ deletingAt }),
		})
		return {
			leaseCount: marked.leaseCount,
			blockingLeases: marked.blockingLeases ?? [],
			created,
			deletingAt,
		}
	} catch (error) {
		if (created) {
			await input.db
				.prepare(
					`UPDATE users
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
				)
				.bind(now, input.dbUserId, now)
				.run()
			invalidatePackageAppOwnerCache({ stableUserId })
		}
		throw error
	}
}

/**
 * Undo {@link markAccountDeleting} when deletion aborts before cleanup.
 * Clears D1 `users.deleting_at` first (permanent gate), then the UserMeter
 * tombstone. Pass `expectedDeletingAt` so a concurrent/retry fence is left
 * alone. A later write may still fail closed if the DO clear is delayed.
 */
export async function abortAccountDeleting(input: {
	db: D1Database
	dbUserId: number
	now?: Date
	env: UserMeterEnv
	/**
	 * When set, clear D1 and UserMeter only if they still hold this exact
	 * fence. Omit for an operator abort of whatever leftover tombstone exists.
	 */
	expectedDeletingAt?: string
}) {
	const userRow = await input.db
		.prepare(
			`SELECT stable_user_id
			FROM users
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.dbUserId)
		.first<{ stable_user_id: OwnerId }>()
	const now = utcSqliteTimestamp(input.now ?? new Date())
	const result = input.expectedDeletingAt
		? await input.db
				.prepare(
					`UPDATE users
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
				)
				.bind(now, input.dbUserId, input.expectedDeletingAt)
				.run()
		: await input.db
				.prepare(
					`UPDATE users
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(now, input.dbUserId)
				.run()
	if (!input.expectedDeletingAt && (result.meta.changes ?? 0) !== 1) {
		throw new Error('Account deletion fence could not be cleared.')
	}
	const stableUserId = userRow?.stable_user_id
	if (!stableUserId) {
		throw new Error('Account deletion fence could not be cleared.')
	}
	const env = requireUserMeterEnv(input.env)
	await runUserMeterRpc({
		env,
		stableUserId,
		operation: async (meter) =>
			await meter.clearDeleting(
				input.expectedDeletingAt
					? { expectedDeletingAt: input.expectedDeletingAt }
					: undefined,
			),
	})
	invalidatePackageAppOwnerCache({ stableUserId })
}

/**
 * Drop a UserMeter deletion tombstone without touching D1 `users.deleting_at`.
 *
 * Completed account deletion deletes the D1 user row but `UserMeter.purge()`
 * restores the tombstone so in-flight cleanup stays fenced. This clear runs
 * after the user row is gone so the purged object holds no state.
 */
export async function clearUserMeterDeletionTombstone(input: {
	env: UserMeterEnv
	stableUserId: OwnerId
}): Promise<{ cleared: boolean }> {
	if (!userMeterNamespace(input.env)) {
		return { cleared: false }
	}
	return await runUserMeterRpc({
		env: input.env,
		stableUserId: input.stableUserId,
		operation: async (meter) => await meter.clearDeleting(),
	})
}

/**
 * Operator entry for {@link abortAccountDeleting}. Resolves `users.id` from
 * `stable_user_id` so admin tools never take the numeric D1 join key.
 */
export async function abortAccountDeletingByStableUserId(input: {
	db: D1Database
	stableUserId: OwnerId
	now?: Date
	env: UserMeterEnv
}) {
	const userRow = await input.db
		.prepare(
			`SELECT id
			FROM users
			WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.stableUserId)
		.first<{ id: number }>()
	if (!userRow) {
		throw new Error('User not found.')
	}
	await abortAccountDeleting({
		db: input.db,
		dbUserId: userRow.id,
		now: input.now,
		env: input.env,
	})
}

export type MarkOrgDeletingResult = {
	leaseCount: number
	blockingLeases: Array<BlockingAccountWriteLease>
	/** True when this invocation wrote `orgs.deleting_at`. */
	created: boolean
	deletingAt: string
}

/**
 * Fence OwnerId writes under an org before soft-delete sweeps resources.
 * Sets `orgs.deleting_at`, then the org-id UserMeter tombstone.
 * {@link assertAccountWritableDb} treats a deleting/deleted org as
 * non-writable even when a live personal-user row shares the same id, so
 * leftover-tombstone heal cannot clear this fence while the org is fenced.
 */
export async function markOrgDeleting(input: {
	db: D1Database
	orgId: OwnerId
	now?: Date
	env: UserMeterEnv
}): Promise<MarkOrgDeletingResult> {
	const now = utcSqliteTimestamp(input.now ?? new Date())
	const createResult = await input.db
		.prepare(
			`UPDATE orgs
			SET deleting_at = ?, updated_at = ?
			WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(now, now, input.orgId)
		.run()
	const created = (createResult.meta.changes ?? 0) === 1
	const orgRow = await input.db
		.prepare(
			`SELECT deleting_at
			FROM orgs
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId)
		.first<{ deleting_at: string | null }>()
	const deletingAt = orgRow?.deleting_at
	if (!deletingAt) {
		throw new Error('Organization could not be marked for deletion.')
	}

	invalidatePackageAppOwnerCache({ stableUserId: input.orgId })
	try {
		const env = requireUserMeterEnv(input.env)
		const marked = await runUserMeterRpc({
			env,
			stableUserId: input.orgId,
			operation: async (meter) => await meter.markDeleting({ deletingAt }),
		})
		return {
			leaseCount: marked.leaseCount,
			blockingLeases: marked.blockingLeases ?? [],
			created,
			deletingAt,
		}
	} catch (error) {
		if (created) {
			await input.db
				.prepare(
					`UPDATE orgs
					SET deleting_at = NULL, updated_at = ?
					WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
				)
				.bind(now, input.orgId, deletingAt)
				.run()
			invalidatePackageAppOwnerCache({ stableUserId: input.orgId })
		}
		throw error
	}
}

/**
 * Undo {@link markOrgDeleting} when org soft-delete aborts before cleanup.
 */
export async function abortOrgDeleting(input: {
	db: D1Database
	orgId: OwnerId
	now?: Date
	env: UserMeterEnv
	expectedDeletingAt?: string
}) {
	const now = utcSqliteTimestamp(input.now ?? new Date())
	if (input.expectedDeletingAt) {
		await input.db
			.prepare(
				`UPDATE orgs
				SET deleting_at = NULL, updated_at = ?
				WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
			)
			.bind(now, input.orgId, input.expectedDeletingAt)
			.run()
	} else {
		await input.db
			.prepare(
				`UPDATE orgs
				SET deleting_at = NULL, updated_at = ?
				WHERE id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(now, input.orgId)
			.run()
	}
	const env = requireUserMeterEnv(input.env)
	await runUserMeterRpc({
		env,
		stableUserId: input.orgId,
		operation: async (meter) =>
			await meter.clearDeleting(
				input.expectedDeletingAt
					? { expectedDeletingAt: input.expectedDeletingAt }
					: undefined,
			),
	})
	invalidatePackageAppOwnerCache({ stableUserId: input.orgId })
}

/**
 * OwnerIds may be a personal org (same id as `users.stable_user_id`) or a
 * team org (`orgs.id` with no users row). A soft-deleted or deleting person
 * must stay non-writable even while their personal org row is still live —
 * never treat a missing *live* users row as a team org when a tombstone
 * exists. A live person whose personal org (same id) is deleting/deleted is
 * also blocked so org soft-delete fencing cannot be cleared by leftover
 * UserMeter heal. Only OwnerIds with no users row at all use the live org
 * check alone (team orgs).
 */
export async function assertAccountWritableDb(
	db: D1Database,
	stableUserId: OwnerId,
) {
	// `stableUserId` is an OwnerId: a personal org id, a team org id, or (legacy
	// equal-id shape) a person id. Resolve the person by stable_user_id or
	// personal_org_id, and the org by id (or the person's personal_org_id).
	// Pre-Teams test DBs may lack `orgs`; treat that as no org row.
	const userStatement = db
		.prepare(
			`SELECT deleting_at, stable_user_id, personal_org_id
			 FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)
			   ${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId, stableUserId)
	const softDeletedPersonStatement = db
		.prepare(
			`SELECT 1 AS present
			FROM users
			WHERE (stable_user_id = ? OR personal_org_id = ?)
			  AND deleted_at IS NOT NULL`,
		)
		.bind(stableUserId, stableUserId)
	const orgStatement = db
		.prepare(`SELECT deleting_at, deleted_at FROM orgs WHERE id = ?`)
		.bind(stableUserId)

	const [row, orgOutcome] = await Promise.all([
		userStatement.first<{
			deleting_at: string | null
			stable_user_id: string
			personal_org_id: string | null
		}>(),
		orgStatement
			.first<{ deleting_at: string | null; deleted_at: string | null }>()
			.then(
				(org) => ({ org, orgsTableMissing: false }),
				(error: unknown) => {
					if (
						error instanceof Error &&
						/no such table:\s*orgs/i.test(error.message)
					) {
						return { org: null, orgsTableMissing: true }
					}
					throw error
				},
			),
	])
	let { org, orgsTableMissing } = orgOutcome

	if (row) {
		if (row.deleting_at) throw new AccountDeletionInProgressError()
		const personalOrgId = row.personal_org_id?.trim() || row.stable_user_id
		if (!org && personalOrgId !== stableUserId && !orgsTableMissing) {
			org =
				(await db
					.prepare(`SELECT deleting_at, deleted_at FROM orgs WHERE id = ?`)
					.bind(personalOrgId)
					.first<{
						deleting_at: string | null
						deleted_at: string | null
					}>()) ?? null
		}
		if (org && (org.deleted_at || org.deleting_at)) {
			throw new AccountDeletionInProgressError()
		}
		return
	}
	// Soft-deleted persons still have a users row; do not treat them as team
	// orgs via the live-org fallback below.
	const softDeletedPerson = await softDeletedPersonStatement.first<{
		present: number
	}>()
	if (softDeletedPerson) {
		throw new AccountDeletionInProgressError()
	}
	if (orgsTableMissing || !org || org.deleted_at || org.deleting_at) {
		throw new AccountDeletionInProgressError()
	}
}

/**
 * After dropping a leftover UserMeter tombstone, re-read D1. A deletion that
 * started in that window already wrote `users.deleting_at` and may have had
 * its DO fence cleared; restore that tombstone before failing closed. Otherwise
 * re-run {@link assertAccountWritableDb} (team orgs, soft-deleted persons,
 * personal-org fences).
 */
async function assertAccountWritableAfterLeftoverTombstoneClear(input: {
	db: D1Database
	env: UserMeterEnv
	stableUserId: OwnerId
}) {
	// Lease / meter keys are OwnerIds (personal org id). Resolve the person by
	// stable_user_id or personal_org_id so distinct signup orgs restore the fence.
	const row = await input.db
		.prepare(
			`SELECT deleting_at, personal_org_id, stable_user_id
			 FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)
			   ${andLiveDeletedAtSql()}`,
		)
		.bind(input.stableUserId, input.stableUserId)
		.first<{
			deleting_at: string | null
			personal_org_id: string | null
			stable_user_id: string
		}>()
	const deletingAt = row?.deleting_at
	if (deletingAt) {
		const meterOwnerId = ownerIdFromStored(
			row.personal_org_id?.trim() || row.stable_user_id,
		)
		await runUserMeterRpc({
			env: input.env,
			stableUserId: meterOwnerId,
			operation: async (meter) => await meter.markDeleting({ deletingAt }),
		})
		throw new AccountDeletionInProgressError()
	}
	await assertAccountWritableDb(input.db, input.stableUserId)
}

export async function assertAccountWritable(env: Env, stableUserId: OwnerId) {
	await assertAccountWritableDb(env.APP_DB, stableUserId)
}

/**
 * Live lease frames keyed by stable user id, propagated down the current
 * async call chain. Nested {@link withAccountWriteLease} calls for the same
 * user reuse the outer lease while its frame is still active instead of
 * paying another acquire/release round trip: the outer lease spans the nested
 * write, so deletion stays blocked for exactly as long as it does today. MCP
 * requests, app requests, job runs, and package invocations all take a lease
 * at their boundary, so before this reuse a single execute call that invoked
 * one package export paid for two full leases.
 *
 * Frames deactivate when the outer lease releases. Detached work (for
 * example callbacks spawned inside `write`) inherits this AsyncLocalStorage
 * context, and without the active flag it would keep skipping acquisition
 * after the lease row was already released.
 */
type AccountWriteLeaseFrame = { active: boolean }
const heldAccountWriteLeaseStorage = new AsyncLocalStorage<
	ReadonlyMap<string, AccountWriteLeaseFrame>
>()

export async function withAccountWriteLease<T>(input: {
	db: D1Database
	stableUserId: OwnerId
	holder?: string
	env: UserMeterEnv
	write: () => Promise<T>
}) {
	const heldLeases = heldAccountWriteLeaseStorage.getStore()
	if (heldLeases?.get(input.stableUserId)?.active) {
		return await input.write()
	}
	const frame: AccountWriteLeaseFrame = { active: true }
	const nextHeldLeases = new Map(heldLeases)
	nextHeldLeases.set(input.stableUserId, frame)
	try {
		return await heldAccountWriteLeaseStorage.run(
			nextHeldLeases,
			async () =>
				await acquireDoAccountWriteLeaseAndWrite({
					...input,
					env: requireUserMeterEnv(input.env),
					frame,
				}),
		)
	} finally {
		frame.active = false
	}
}

async function acquireDoAccountWriteLeaseAndWrite<T>(input: {
	db: D1Database
	stableUserId: OwnerId
	holder?: string
	env: UserMeterEnv
	frame: AccountWriteLeaseFrame
	write: () => Promise<T>
}) {
	await assertAccountWritableDb(input.db, input.stableUserId)
	const lease: AccountWriteLease = {
		token: crypto.randomUUID(),
		stableUserId: input.stableUserId,
		holder: input.holder ?? 'unspecified',
		acquiredAt: utcSqliteTimestamp(),
	}
	const acquire = async () =>
		await runUserMeterRpc({
			env: input.env,
			stableUserId: lease.stableUserId,
			operation: async (meter) =>
				await meter.acquireWriteLease({
					token: lease.token,
					holder: lease.holder,
					acquiredAt: lease.acquiredAt,
				}),
		})
	let acquired = await acquire()
	if (!acquired.acquired) {
		// Live D1 + meter tombstone is a leftover fence (completed deletion
		// restored the tombstone; before random ids, the same email signed up
		// again with the same email-hash id). Re-check D1
		// before clearing so a deletion that started after the first acquire
		// keeps its tombstone, then re-check after the clear so a deletion that
		// landed in that window cannot acquire a write lease.
		await assertAccountWritableDb(input.db, input.stableUserId)
		await clearUserMeterDeletionTombstone({
			env: input.env,
			stableUserId: lease.stableUserId,
		})
		await assertAccountWritableAfterLeftoverTombstoneClear({
			db: input.db,
			env: input.env,
			stableUserId: lease.stableUserId,
		})
		acquired = await acquire()
	}
	if (!acquired.acquired) {
		throw new AccountDeletionInProgressError()
	}
	// Releasing reports whether the lease row was still there, so one DO round
	// trip both proves the lease was held for the whole write and releases it.
	const release = async () =>
		await runUserMeterRpc({
			env: input.env,
			stableUserId: lease.stableUserId,
			operation: async (meter) =>
				await meter.releaseWriteLease({ token: lease.token }),
		})
	// Without renewal the lease lapses, which is how a killed writer stops
	// blocking deletion. A failed renewal is retried on the next beat.
	const heartbeat = setInterval(() => {
		void runUserMeterRpc({
			env: input.env,
			stableUserId: lease.stableUserId,
			operation: async (meter) =>
				await meter.renewWriteLease({ token: lease.token }),
		}).then(
			(renewed) => {
				if (renewed.renewed) return
				// A deletion dropped the lease. The write in flight fails at
				// release; nested writes must not ride on a lease that is gone.
				clearInterval(heartbeat)
				input.frame.active = false
			},
			() => {},
		)
	}, accountWriteLeaseHeartbeatMs)
	let result: T
	try {
		result = await input.write()
	} catch (error) {
		clearInterval(heartbeat)
		input.frame.active = false
		await release()
		throw error
	}
	clearInterval(heartbeat)
	input.frame.active = false
	const released = await release()
	if (!released.released) throw new AccountWriteLeaseLostError()
	return result
}

export async function listActiveAccountWriteLeases(
	env: UserMeterEnv,
	stableUserId: OwnerId,
): Promise<Array<ListedAccountWriteLease>> {
	const requiredEnv = requireUserMeterEnv(env)
	const leases: Array<ListedAccountWriteLease> = []
	let startAfter: string | null = null
	for (;;) {
		const page = await runUserMeterRpc({
			env: requiredEnv,
			stableUserId,
			operation: async (meter) =>
				await meter.listWriteLeases({
					pageSize: 500,
					startAfter,
				}),
		})
		for (const lease of page.leases) {
			leases.push({
				token: lease.token,
				holder: lease.holder,
				acquired_at: lease.acquiredAt,
			})
		}
		if (!page.nextStartAfter) break
		startAfter = page.nextStartAfter
	}
	return leases
}

export async function repairAccountWriteLease(input: {
	db: D1Database
	stableUserId: OwnerId
	token: string
	expectedAcquiredAt: string
	repairedByUserId: string
	reason: string
	env: UserMeterEnv
}) {
	if (input.reason.trim().length < 10) {
		throw new Error('Lease repair requires a detailed audit reason.')
	}
	const reason = input.reason.trim()
	const env = requireUserMeterEnv(input.env)
	const prepared = await runUserMeterRpc({
		env,
		stableUserId: input.stableUserId,
		operation: async (meter) =>
			await meter.prepareWriteLeaseRepair({
				token: input.token,
				expectedAcquiredAt: input.expectedAcquiredAt,
			}),
	})
	if (prepared.prepared) {
		const now = utcSqliteTimestamp()
		await insertOrVerifyDoRepairAudit({
			db: input.db,
			repairId: prepared.repairId,
			stableUserId: input.stableUserId,
			token: prepared.token,
			holder: prepared.holder,
			acquiredAt: prepared.acquiredAt,
			repairedByUserId: input.repairedByUserId,
			reason,
			now,
		})
		// Finalize DO lease; fail closed on transport errors (audit row persists for retry).
		await runUserMeterRpc({
			env,
			stableUserId: input.stableUserId,
			operation: async (meter) =>
				await meter.finalizeWriteLeaseRepair({
					token: prepared.token,
					repairId: prepared.repairId,
					expectedAcquiredAt: prepared.acquiredAt,
				}),
		})
		return { repaired: true as const, repairId: prepared.repairId }
	}
	// Lost-finalize retry: matching audit + absent DO lease → already repaired.
	const existingAudit = await findMatchingRepairAudit({
		db: input.db,
		stableUserId: input.stableUserId,
		token: input.token,
		expectedAcquiredAt: input.expectedAcquiredAt,
		repairedByUserId: input.repairedByUserId,
		reason,
	})
	if (existingAudit) {
		const stillHeld = await runUserMeterRpc({
			env,
			stableUserId: input.stableUserId,
			operation: async (meter) =>
				await meter.assertWriteLeaseHeld({
					token: input.token,
				}),
		})
		if (!stillHeld.held) {
			return { repaired: true as const, repairId: existingAudit.id }
		}
		throw new Error('Active account write lease did not match repair request.')
	}
	throw new Error('Active account write lease did not match repair request.')
}
