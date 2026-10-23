import { type CommunityForkRecord } from './types.ts'

/**
 * Not-found copy for a lookup that matched a pending (unpublished) community
 * fork. See `findPendingCommunityForkForLookup` in `./repo.ts`.
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
	return `${name} (package_id ${input.fork.forkedPackageId}) is a community fork that has not been published yet, so it is not a saved package and has no package git remote yet. Its source exists: open it with repoOpenSession using source_id "${input.fork.forkedSourceId}", review it, then publish with repoPublishSession. After that first publish, packageGet, packageGetGitRemote, and git clone of ${name}.git work with the same package_id and name.`
}
