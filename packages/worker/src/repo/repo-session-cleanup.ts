import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { Clock, Effect, Schema } from 'effect'
import { retryDurableObjectReset } from '#worker/effect/durable-object.ts'
import { decodeOutbound, outbound } from '#worker/effect/outbound.ts'
import { runSlicePromiseLazy as runSlicePromise } from '#worker/effect/slice-edge.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import {
	deferRepoSessionDueOwner,
	deferRepoSessionDueOwnerEffect,
	listDueRepoSessionOwners,
	listDueRepoSessionOwnersEffect,
	repoSessionDueOwnerBatchSize,
} from './repo-session-due-owners.ts'
import { repoSessionIndexRpc } from './repo-session-index-client.ts'

export type RepoSessionBranchCleanupResult = {
	checked: number
	deleted: number
	errors: number
}

export async function cleanupRepoSessionBranches(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<RepoSessionBranchCleanupResult> {
	const now = input.now ?? new Date()
	const owners = await listDueRepoSessionOwners({
		db: input.env.APP_DB,
		now,
		limit: input.batchSize ?? repoSessionDueOwnerBatchSize,
	})
	let checked = 0
	let deleted = 0
	let errors = 0
	for (const owner of owners) {
		try {
			const result = await repoSessionIndexRpc({
				env: input.env,
				userId: owner.userId,
			}).runDueCleanup({
				ownerId: owner.userId,
				now: now.toISOString(),
			})
			checked += result.checked
			deleted += result.deleted
			errors += result.errors
		} catch (error) {
			errors += 1
			await deferRepoSessionDueOwner({
				db: input.env.APP_DB,
				userId: owner.userId,
				error,
				now,
			}).catch((deferError: unknown) => {
				console.warn(
					JSON.stringify({
						message: 'repo session due-owner defer failed',
						error: getErrorMessage(deferError),
					}),
				)
			})
		}
	}
	return {
		checked,
		deleted,
		errors,
	}
}

const CleanupResponse = Schema.Struct({
	checked: Schema.Number,
	deleted: Schema.Number,
	errors: Schema.Number,
})

/**
 * `cleanupRepoSessionBranches` as an Effect. Each owner's index RPC runs
 * under the outbound deadline, so one wedged index defers that owner instead
 * of holding the whole lane.
 */
export const cleanupRepoSessionBranchesEffect = Effect.fn(
	'RepoSessionCleanup.run',
)(function* (input: { now?: Date; batchSize?: number }) {
	const env = yield* WorkerEnv
	const now = input.now ?? new Date(yield* Clock.currentTimeMillis)
	const owners = yield* listDueRepoSessionOwnersEffect({
		now,
		limit: input.batchSize ?? repoSessionDueOwnerBatchSize,
	})
	const totals: RepoSessionBranchCleanupResult = {
		checked: 0,
		deleted: 0,
		errors: 0,
	}
	for (const owner of owners) {
		yield* retryDurableObjectReset(
			outbound('repo_session_index.run_due_cleanup', () =>
				repoSessionIndexRpc({ env, userId: owner.userId }).runDueCleanup({
					ownerId: owner.userId,
					now: now.toISOString(),
				}),
			),
		).pipe(
			Effect.flatMap(
				decodeOutbound('repo_session_index.run_due_cleanup', CleanupResponse),
			),
			Effect.matchEffect({
				onSuccess: (result) =>
					Effect.sync(() => {
						totals.checked += result.checked
						totals.deleted += result.deleted
						totals.errors += result.errors
					}),
				onFailure: (error) => {
					totals.errors += 1
					return deferRepoSessionDueOwnerEffect({
						userId: owner.userId,
						error: error.reason === 'failed' ? error.cause : error,
						now,
					}).pipe(
						Effect.catch((deferError) =>
							Effect.sync(() =>
								console.warn(
									JSON.stringify({
										message: 'repo session due-owner defer failed',
										error: deferError.message,
									}),
								),
							),
						),
					)
				},
			}),
		)
	}
	return totals
})

/** Promise edge for tests and callers outside the slice. */
export const cleanupRepoSessionBranchesViaEffect = (
	input: Parameters<typeof cleanupRepoSessionBranches>[0],
) =>
	runSlicePromise(
		input.env,
		cleanupRepoSessionBranchesEffect({
			now: input.now,
			batchSize: input.batchSize,
		}),
	)
