import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { ServingAdvanceActor } from '#worker/package-capabilities/serving-commit-advance.ts'
import { repoSessionRpc } from './repo-session-rpc.ts'

export type PackageServingUpdate = {
	sourceId: string
	userId: OwnerId
} & (
	| { kind: 'advance'; commit: string; actor?: ServingAdvanceActor }
	| {
			kind: 'refresh-jobs'
			packageId: string
			baseUrl: string
			actor?: ServingAdvanceActor
	  }
)

export function updatePackageServing(env: Env, update: PackageServingUpdate) {
	return repoSessionRpc(
		env,
		`package-serving-${update.sourceId}`,
	).updatePackageServing(update)
}

/** One queue per source-named RepoSession, independent of any build session. */
export class PackageServingUpdateQueue {
	private tail = Promise.resolve()

	async run(env: Env, update: PackageServingUpdate) {
		const next = this.tail.then(async () => {
			if (update.kind === 'advance') {
				const { advancePackageServingCommit } =
					await import('#worker/package-capabilities/serving-commit-advance.ts')
				return await advancePackageServingCommit({ env, ...update })
			}
			const { syncPublishedPackageJobs } =
				await import('#worker/jobs/service.ts')
			await syncPublishedPackageJobs({
				env,
				...update,
				actorUserId: update.actor?.userId,
				actorCredential: update.actor?.credential ?? null,
			})
			return { advanced: false }
		})
		this.tail = next.then(
			() => {},
			() => {},
		)
		return await next
	}
}
