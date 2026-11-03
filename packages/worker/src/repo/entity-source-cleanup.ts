import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { deletePublishedArtifactsForSource } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { deletePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { cleanupArtifactReposForSource } from './artifact-repo-cleanup.ts'
import { deleteEntitySource } from './entity-sources.ts'
import { deleteRepoSessionsBySourceForUser } from './repo-sessions.ts'
import type { EntitySourceRow } from './types.ts'

/** Deletes an entity source no live entity references, with its repo and artifacts. */
export async function deleteEntitySourceWithArtifacts(input: {
	env: Env
	userId: OwnerId
	source: EntitySourceRow
}) {
	const { source } = input
	const artifactCleanup = await cleanupArtifactReposForSource({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
	})
	if (
		source.repo_id.trim() &&
		artifactCleanup.deleted === 0 &&
		!artifactCleanup.artifactAccessUnavailable
	) {
		throw new Error(`Artifact repo cleanup failed for source ${source.id}.`)
	}
	await deleteRepoSessionsBySourceForUser(input.env, {
		userId: input.userId,
		sourceId: source.id,
	})
	await deletePublishedArtifactsForSource({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
	})
	await deletePublishedSourceSnapshot({
		env: input.env,
		sourceId: source.id,
		publishedCommit: source.published_commit,
	})
	await deleteEntitySource(input.env, {
		id: source.id,
		userId: input.userId,
	})
}
