import type { EntitySourceRow } from './types.ts'

/**
 * The commit runtime readers serve: the last published commit whose every
 * bundle artifact target is saved. Publish advances `published_commit` before
 * it builds targets, so readers must not follow it until `serving_commit`
 * catches up. Sources without a serving pointer yet serve `published_commit`.
 */
export function servingCommitForSource(
	source: Pick<EntitySourceRow, 'published_commit' | 'serving_commit'>,
): string | null {
	return source.serving_commit ?? source.published_commit
}

/**
 * The source row as runtime readers (apps, modules, exports, subscriptions,
 * jobs) see it: `published_commit` is the serving commit, so every
 * commit-keyed snapshot, manifest, and artifact they load agrees. Publish,
 * checks, and rebuild code keep the raw row.
 */
export function toServingSourceView<
	T extends Pick<EntitySourceRow, 'published_commit' | 'serving_commit'>,
>(source: T): T {
	const servingCommit = servingCommitForSource(source)
	return servingCommit === source.published_commit
		? source
		: { ...source, published_commit: servingCommit }
}
