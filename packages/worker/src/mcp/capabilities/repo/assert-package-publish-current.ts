import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { buildPublishedCommitMovedDuringPublishMessage } from '#worker/repo/publish-concurrency-caller-error.ts'

/** A build can finish after a different publish or a rollback moved the tip. */
export async function assertPackagePublishCurrent(input: {
	env: Env
	sourceId: string
	userId: OwnerId
	commit: string
}) {
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (
		source?.published_commit !== input.commit ||
		(source.serving_commit !== input.commit &&
			source.held_commit !== input.commit)
	) {
		throw new McpCallerError(buildPublishedCommitMovedDuringPublishMessage())
	}
}
