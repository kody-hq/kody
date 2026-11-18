import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { clearPublishedPublishChecksVersion } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	getEntitySourceByIdForUser,
	revertEntitySourcePublishedCommit,
} from '#worker/repo/entity-sources.ts'

/**
 * RepoSession promotes and seals the tip (pointer, projection, job pins)
 * before the artifact rebuild runs. When that rebuild fails the publish did
 * not succeed: drop the seal so a retry re-runs it, and move the pointer,
 * projection, and job pins back to the last good commit so nothing points at
 * a commit whose artifacts never finished. A first publish has no earlier
 * commit to restore, so only its seal is dropped.
 *
 * Returns the restored commit when the pointer moved back, `superseded` when a newer
 * publish already owns it, and `unchanged` when there was nothing to restore.
 *
 * Resumable: the pointer CAS and the projection refresh are separate writes,
 * so a refresh that throws leaves the pointer already at a built commit. A
 * retry finishes the refresh if the pointer is already on that built commit.
 */
export async function settleFailedPublishRebuild(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId
	packageId: string
	sourceId: string
	failedCommit: string
	sentryScope: string
}): Promise<
	| { status: 'restored'; commit: string }
	| { status: 'superseded' | 'unchanged' }
> {
	await clearPublishedPublishChecksVersion({
		env: input.env,
		sourceId: input.sourceId,
		publishedCommit: input.failedCommit,
	})
	const sourceKey = { id: input.sourceId, userId: input.ownerUserId }
	let restoredCommit = await revertEntitySourcePublishedCommit(
		input.env.APP_DB,
		{ ...sourceKey, failedCommit: input.failedCommit },
	)
	if (!restoredCommit) {
		const current = await getEntitySourceByIdForUser(
			input.env.APP_DB,
			sourceKey,
		)
		if (current?.published_commit === input.failedCommit) {
			return { status: 'unchanged' }
		}
		const builtCommit = current?.held_commit ?? current?.serving_commit
		if (!builtCommit || current?.published_commit !== builtCommit) {
			return { status: 'superseded' }
		}
		restoredCommit = builtCommit
	}
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
				restoredCommit,
			},
		})
		throw error
	}
	return { status: 'restored', commit: restoredCommit }
}
