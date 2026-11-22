import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	deferRepoSessionDueOwner,
	listDueRepoSessionOwners,
	repoSessionDueOwnerBatchSize,
} from './repo-session-due-owners.ts'
import { repoSessionIndexRpc } from './repo-session-index-client.ts'

/** One wedged index must not hold the lane; its owner is deferred instead. */
export const repoSessionOwnerCleanupTimeoutMs = 30_000

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
		let timeout: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race([
				repoSessionIndexRpc({
					env: input.env,
					userId: owner.userId,
				}).runDueCleanup({
					ownerId: owner.userId,
					now: now.toISOString(),
				}),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error('repo_session_owner_cleanup_timeout')),
						repoSessionOwnerCleanupTimeoutMs,
					)
				}),
			])
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
		} finally {
			clearTimeout(timeout)
		}
	}
	return {
		checked,
		deleted,
		errors,
	}
}
