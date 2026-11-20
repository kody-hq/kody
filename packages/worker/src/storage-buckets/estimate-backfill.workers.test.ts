import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { backfillStorageBucketEstimates } from './estimate-backfill.ts'
import {
	listUserStorageBucketEstimates,
	registerStorageBucket,
} from './service.ts'
import { ensureUserStorageBucketsTestSchema } from './test-schema.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
// The first Durable Object RPC in a fresh test isolate lazily loads the whole
// worker main module (several seconds), which would otherwise trip the
// backfill's bounded per-read estimate timeout and the default test timeout.
const testTimeout = 30_000

test(
	'backfill seeds stored estimates for unmeasured buckets in bounded batches',
	{ timeout: testTimeout },
	async () => {
		await ensureUserStorageBucketsTestSchema(env.APP_DB)
		resetIsolateState()
		const userId = `usb-backfill-${crypto.randomUUID()}`
		const bucketA = `exec:${crypto.randomUUID()}`
		const bucketB = `package:${crypto.randomUUID()}`
		const sessionId = crypto.randomUUID()
		const sessionBucket = `repo-session:${sessionId}`
		// Warm the Durable Object namespace with an unbounded RPC so the
		// backfill's 2s-bounded estimate reads measure steady-state behavior.
		await storageRunnerRpc({
			env,
			userId: ownerIdFromStored(userId),
			storageId: bucketA,
		}).getEstimatedBytes()
		const sessionEstimate = (
			await repoSessionRpc(env, sessionId).getEstimatedBytes()
		).estimatedBytes
		const pending: Array<Promise<unknown>> = []
		const waitUntil = (promise: Promise<unknown>) => {
			pending.push(promise)
		}
		const buckets = [
			[bucketA, 'execute'],
			[sessionBucket, 'repo_session'],
			[bucketB, 'package'],
		] as const
		for (const [storageId, kind] of buckets) {
			registerStorageBucket({ env, userId, storageId, kind, waitUntil })
		}
		await Promise.all(pending)
		const expectedRows = (estimate: (storageId: string) => number | null) =>
			buckets
				.map(([storageId, kind]) => ({
					storageId,
					kind,
					estimatedBytes: estimate(storageId),
				}))
				.sort((a, b) => (a.storageId < b.storageId ? -1 : 1))

		// Registration alone leaves estimates NULL (unmeasured).
		await expect(
			listUserStorageBucketEstimates({
				env,
				userId: ownerIdFromStored(userId),
			}),
		).resolves.toEqual(expectedRows(() => null))

		// The bound is respected: batchSize 1 measures exactly one bucket.
		await expect(
			backfillStorageBucketEstimates({ env, batchSize: 1 }),
		).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 })

		// The next sweep finishes the rest; both buckets end up measured at
		// the never-written DO baseline.
		await expect(backfillStorageBucketEstimates({ env })).resolves.toEqual({
			scanned: 2,
			updated: 2,
			failed: 0,
		})
		await expect(
			listUserStorageBucketEstimates({
				env,
				userId: ownerIdFromStored(userId),
			}),
		).resolves.toEqual(
			expectedRows((storageId) =>
				storageId === sessionBucket
					? sessionEstimate
					: emptyStorageRunnerEstimatedBytes,
			),
		)

		// Converged inventories make the lane a cheap no-op.
		await expect(backfillStorageBucketEstimates({ env })).resolves.toEqual({
			scanned: 0,
			updated: 0,
			failed: 0,
		})
	},
)
