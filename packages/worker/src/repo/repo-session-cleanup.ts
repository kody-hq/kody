import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { assertNever, reportLaneError } from '#worker/scheduled/lane-failure.ts'
import {
	deferRepoSessionDueOwner,
	listDueRepoSessionOwners,
	repoSessionDueOwnerBatchSize,
} from './repo-session-due-owners.ts'
import { repoSessionIndexRpc } from './repo-session-index-client.ts'

export type RepoSessionBranchCleanupResult = {
	checked: number
	deleted: number
	errors: number
}

export type RepoSessionCleanupFailure =
	| { kind: 'owner_cleanup_failed'; userId: string; error: unknown }
	| { kind: 'owner_defer_failed'; userId: string; error: unknown }

/** Decides how a failed owner affects the error count and whether it is deferred. */
export function mapRepoSessionCleanupFailure(
	failure: RepoSessionCleanupFailure,
) {
	switch (failure.kind) {
		case 'owner_cleanup_failed':
			return { errors: 1, defer: true }
		case 'owner_defer_failed':
			reportLaneError(
				'warn',
				JSON.stringify({
					message: 'repo session due-owner defer failed',
					error: getErrorMessage(failure.error),
				}),
			)
			return { errors: 0, defer: false }
		default:
			return assertNever(failure, 'repo session cleanup failure')
	}
}

export async function cleanupRepoSessionBranches(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<RepoSessionBranchCleanupResult> {
	const now = input.now ?? new Date()
	const owners = await withDeadline(
		{
			label: 'repo_session_cleanup.list_due_owners',
			timeoutMs: outboundTimeoutMs.d1,
		},
		() =>
			listDueRepoSessionOwners({
				db: input.env.APP_DB,
				now,
				limit: input.batchSize ?? repoSessionDueOwnerBatchSize,
			}),
	)
	let checked = 0
	let deleted = 0
	let errors = 0
	for (const owner of owners) {
		try {
			const result = await withDeadline(
				{
					label: 'repo_session_cleanup.run_due_cleanup',
					timeoutMs: outboundTimeoutMs.durableObject,
				},
				() =>
					repoSessionIndexRpc({
						env: input.env,
						userId: owner.userId,
					}).runDueCleanup({
						ownerId: owner.userId,
						now: now.toISOString(),
					}),
			)
			checked += result.checked
			deleted += result.deleted
			errors += result.errors
		} catch (error) {
			const cleanupFailure = mapRepoSessionCleanupFailure({
				kind: 'owner_cleanup_failed',
				userId: owner.userId,
				error,
			})
			errors += cleanupFailure.errors
			if (!cleanupFailure.defer) continue
			await withDeadline(
				{
					label: 'repo_session_cleanup.defer_owner',
					timeoutMs: outboundTimeoutMs.d1,
				},
				() =>
					deferRepoSessionDueOwner({
						db: input.env.APP_DB,
						userId: owner.userId,
						error,
						now,
					}),
			).catch((deferError: unknown) => {
				mapRepoSessionCleanupFailure({
					kind: 'owner_defer_failed',
					userId: owner.userId,
					error: deferError,
				})
			})
		}
	}
	return {
		checked,
		deleted,
		errors,
	}
}
