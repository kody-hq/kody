import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { replaceRepoSessionDueOwner } from '#worker/repo/repo-session-due-owners.ts'
import { repoSessionIndexRpc } from '#worker/repo/repo-session-index-client.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	maybeRefreshStorageBucketEstimate,
	recordStorageBucketEstimate,
	registerMissingRepoSessionStorageBuckets,
	registerStorageBucket,
} from './service.ts'
import { ensureUserStorageBucketsTestSchema } from './test-schema.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function catalogSessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	// Fresh timestamps keep unused-active sessions outside the due window
	// (`unusedAbandonedSessionRetentionMs`) so insertSession does not arm an
	// immediate cleanup alarm that hangs workers-unit when console.warn throws.
	const now = new Date().toISOString()
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: now,
		updated_at: now,
		...overrides,
	}
}

async function setup() {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}
	return {
		waitUntil,
		flush: () => Promise.all(pending),
		register: (
			userId: string,
			storageId: string,
			kind: Parameters<typeof registerStorageBucket>[0]['kind'],
		) => registerStorageBucket({ env, userId, storageId, kind, waitUntil }),
		estimates: (userId: string) =>
			listUserStorageBucketEstimates({
				env,
				userId: ownerIdFromStored(userId),
			}),
	}
}

test('registerStorageBucket upserts and list helpers scope correctly on real D1', async () => {
	const { register, flush, estimates } = await setup()
	const userA = ownerIdFromStored(`usb-a-${crypto.randomUUID()}`)
	const userB = ownerIdFromStored(`usb-b-${crypto.randomUUID()}`)
	const bucketA = `exec:${crypto.randomUUID()}`
	const bucketB = `job:${crypto.randomUUID()}`
	const sessionBucket = `repo-session:${crypto.randomUUID()}`
	register(userA, bucketA, 'execute')
	register(userB, bucketB, 'job')
	register(userA, sessionBucket, 'repo_session')
	await flush()

	await expect(
		listUserStorageBucketIds({ env, userId: userA }),
	).resolves.toEqual([bucketA])
	await expect(estimates(userA)).resolves.toEqual(
		[
			{ storageId: bucketA, kind: 'execute', estimatedBytes: null },
			{ storageId: sessionBucket, kind: 'repo_session', estimatedBytes: null },
		].sort((left, right) => left.storageId.localeCompare(right.storageId)),
	)
	await expect(
		listUserStorageBucketIds({ env, userId: userB }),
	).resolves.toEqual([bucketB])

	const platform = await listPlatformStorageBuckets({ db: env.APP_DB })
	expect(platform).toEqual(
		expect.arrayContaining([
			{ userId: userA, storageId: bucketA },
			{ userId: userB, storageId: bucketB },
		]),
	)
	expect(platform).not.toContainEqual({
		userId: userA,
		storageId: sessionBucket,
	})
})

test('missing repo-session inventory reconciliation registers only active sessions', async () => {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	const userId = ownerIdFromStored(`usb-reconcile-${crypto.randomUUID()}`)
	const activeSession = `rs-active-${crypto.randomUUID()}`
	const discardedSession = `rs-discarded-${crypto.randomUUID()}`
	const registeredSession = `rs-registered-${crypto.randomUUID()}`
	const index = repoSessionIndexRpc({ env, userId })
	for (const row of [
		catalogSessionRow({ id: activeSession, user_id: userId }),
		catalogSessionRow({
			id: discardedSession,
			user_id: userId,
			status: 'discarded',
		}),
		catalogSessionRow({ id: registeredSession, user_id: userId }),
	]) {
		await index.insertSession({ ownerId: userId, row })
	}
	await replaceRepoSessionDueOwner({
		db: env.APP_DB,
		userId,
		dueAt: '2099-01-01T00:00:00.000Z',
	})
	// Pre-existing inventory row: reconciliation must not duplicate or touch it.
	await env.APP_DB.prepare(
		`INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at, estimated_bytes
		) VALUES (?, ?, 'repo_session', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 42)`,
	)
		.bind(userId, `repo-session:${registeredSession}`)
		.run()

	const inserted = await registerMissingRepoSessionStorageBuckets({
		db: env.APP_DB,
		env,
	})
	expect(inserted).toBeGreaterThanOrEqual(1)

	const estimates = await listUserStorageBucketEstimates({ env, userId })
	const bytesById = new Map(
		estimates.map((row) => [row.storageId, row.estimatedBytes]),
	)
	expect(bytesById.get(`repo-session:${activeSession}`)).toBeNull()
	expect(bytesById.has(`repo-session:${discardedSession}`)).toBe(false)
	expect(bytesById.get(`repo-session:${registeredSession}`)).toBe(42)

	await registerMissingRepoSessionStorageBuckets({ db: env.APP_DB, env })
	const after = await listUserStorageBucketEstimates({ env, userId })
	expect(after.length).toBe(estimates.length)

	for (const sessionId of [
		activeSession,
		discardedSession,
		registeredSession,
	]) {
		await index.deleteSession({ ownerId: userId, sessionId })
	}
})

test('estimate persistence is UPDATE-only, listable, throttled per isolate, and a failed refresh warns without consuming the throttle', async () => {
	const { register, flush, estimates, waitUntil } = await setup()
	const userId = `usb-estimate-${crypto.randomUUID()}`
	const registered = `exec:${crypto.randomUUID()}`
	const unregistered = `exec:${crypto.randomUUID()}`
	register(userId, registered, 'execute')
	await flush()
	await expect(estimates(userId)).resolves.toEqual([
		{ storageId: registered, kind: 'execute', estimatedBytes: null },
	])

	const record = (storageId: string, estimatedBytes: number) =>
		recordStorageBucketEstimate({
			env,
			userId,
			storageId,
			estimatedBytes,
			waitUntil,
		})
	record(registered, 4096)
	// UPDATE-only: recording an estimate for a bucket without an ownership
	// row must not create one (this is what keeps the persist safe on
	// clearStorage paths racing account or bucket deletion).
	record(unregistered, 123)
	await flush()
	await expect(estimates(userId)).resolves.toEqual([
		{ storageId: registered, kind: 'execute', estimatedBytes: 4096 },
	])

	let reads = 0
	const refresh = (
		storageId: string,
		readEstimatedBytes: () => Promise<number>,
	) =>
		maybeRefreshStorageBucketEstimate({
			env,
			userId,
			storageId,
			readEstimatedBytes,
			waitUntil,
		})
	const readEstimatedBytes = async () => {
		reads += 1
		return 8192
	}
	refresh(registered, readEstimatedBytes)
	refresh(registered, readEstimatedBytes)
	await flush()
	expect(reads).toBe(1)
	await expect(estimates(userId)).resolves.toEqual([
		{ storageId: registered, kind: 'execute', estimatedBytes: 8192 },
	])

	consoleWarn.mockImplementation(() => {})
	const retryUserId = `usb-estimate-retry-${crypto.randomUUID()}`
	const retryBucket = `exec:${crypto.randomUUID()}`
	register(retryUserId, retryBucket, 'execute')
	await flush()
	let attempts = 0
	const flakyRead = async () => {
		attempts += 1
		if (attempts === 1) throw new Error('simulated estimate read failure')
		return 2048
	}
	const refreshRetry = () =>
		maybeRefreshStorageBucketEstimate({
			env,
			userId: retryUserId,
			storageId: retryBucket,
			readEstimatedBytes: flakyRead,
			waitUntil,
		})
	refreshRetry()
	await flush()
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-estimate-refresh-failed',
		expect.any(Error),
	)
	refreshRetry()
	await flush()
	expect(attempts).toBe(2)
	await expect(estimates(retryUserId)).resolves.toEqual([
		{ storageId: retryBucket, kind: 'execute', estimatedBytes: 2048 },
	])
})
