/**
 * soft-delete-read-filter: opt-out
 * The pending-fork lookup intentionally matches saved_packages rows whether or
 * not they are soft-deleted: any row means the fork was published before, so
 * it is not pending.
 */
import { communityForkSelectColumns, mapCommunityForkRow } from './repo.ts'
import { type CommunityForkRecord } from './types.ts'

/**
 * Not-found copy for a lookup that matched a pending (unpublished) community
 * fork. See `findPendingCommunityForkForLookup` below.
 */
export function buildPendingCommunityForkLookupMessage(input: {
	fork: Pick<
		CommunityForkRecord,
		'forkedPackageId' | 'forkedSourceId' | 'targetKodyId'
	>
	ownerScope: string
}): string {
	const scope = input.ownerScope.replace(/^@/, '')
	const name = `@${scope}/${input.fork.targetKodyId}`
	return `${name} (package_id ${input.fork.forkedPackageId}) is a community fork that has not been published yet, so it is not a saved package and has no package git remote yet. Its source exists: open it with repoOpenSession using source_id "${input.fork.forkedSourceId}", review it, then publish with repoPublishSession. After that first publish, packageGet works with package_id ${input.fork.forkedPackageId}, and packageGetGitRemote and git clone of ${name}.git work with the name.`
}

/**
 * A community fork is inert until its first `repoPublishSession`: it has an
 * entity source, an Artifacts repo, and a `community_forks` row, but no
 * `saved_packages` row. Package lookups (`packageGet`, `packageGetGitRemote`,
 * and other name / package_id resolvers) read `saved_packages` only, so the
 * `package_id` and name leaf `communityFork` just returned looked missing.
 *
 * This finds that pending fork so the not-found error can point the caller at
 * the fork's source session instead. Any saved package row, even a
 * soft-deleted one, means the fork was published before and is not pending.
 */
export async function findPendingCommunityForkForLookup(
	db: D1Database,
	input: {
		forkerUserId: string
		packageIdOrKodyId: string
	},
): Promise<CommunityForkRecord | null> {
	const ref = input.packageIdOrKodyId.trim()
	if (!ref) return null
	const row = await db
		.prepare(
			`SELECT ${communityForkSelectColumns}
			FROM community_forks
			WHERE forker_user_id = ?
				AND (forked_package_id = ? OR target_kody_id = ?)
				AND NOT EXISTS (
					SELECT 1
					FROM saved_packages
					WHERE saved_packages.id = community_forks.forked_package_id
				)
			ORDER BY created_at DESC
			LIMIT 1`,
		)
		.bind(input.forkerUserId, ref, ref)
		.first<Record<string, unknown>>()
	return row ? mapCommunityForkRow(row) : null
}
