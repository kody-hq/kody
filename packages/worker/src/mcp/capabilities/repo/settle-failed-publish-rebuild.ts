import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { clearPublishedPublishChecksVersion } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { revertEntitySourcePublishedCommit } from '#worker/repo/entity-sources.ts'

/**
 * RepoSession promotes and seals the tip (pointer, projection, job pins)
 * before the artifact rebuild runs. When that rebuild fails the publish did
 * not succeed: drop the seal so a retry re-runs it, and move the pointer,
 * projection, and job pins back to the last good commit so nothing points at
 * a commit whose artifacts never finished. A first publish has no earlier
 * commit to restore, so only its seal is dropped.
 *
 * Returns `restored` when the pointer moved back, `superseded` when a newer
 * publish already owns it, and `unchanged` when there was nothing to restore.
 */
export async function settleFailedPublishRebuild(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId
	packageId: string
	sourceId: string
	failedCommit: string
	restoreCommit: string | null
	sentryScope: string
}): Promise<'restored' | 'superseded' | 'unchanged'> {
	await clearPublishedPublishChecksVersion({
		env: input.env,
		sourceId: input.sourceId,
		publishedCommit: input.failedCommit,
	})
	const restoreCommit = input.restoreCommit
	if (restoreCommit == null || restoreCommit === input.failedCommit) {
		return 'unchanged'
	}
	const reverted = await revertEntitySourcePublishedCommit(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.ownerUserId,
		failedCommit: input.failedCommit,
		restoreCommit,
	})
	// A newer publish already moved the pointer; its own finalize owns the
	// projection now.
	if (!reverted) return 'superseded'
	try {
		await refreshSavedPackageProjection({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.ownerUserId,
			packageId: input.packageId,
			sourceId: input.sourceId,
			rebuildArtifacts: false,
			audit: null,
		})
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: input.sentryScope },
			extra: {
				sourceId: input.sourceId,
				failedCommit: input.failedCommit,
				restoreCommit,
			},
		})
		throw error
	}
	return 'restored'
}
