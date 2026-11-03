import type { CommunityListingRelease } from '#worker/community/fork-upstream-updated-subscription-event.ts'
import { deliverFollowRecords, deliverListingForkAliases } from './deliver.ts'
import { hasAppDb, listActiveFollowsByTarget } from './repo.ts'

/**
 * Fan `follow.published` out to active follows of a package whose live
 * version moved. When `listing` pin moved, also emit
 * `community.fork.upstream_updated` once per fork still behind that pin,
 * including forks whose follow is paused or absent.
 * Best-effort: a failure here must not unwind publish.
 */
export async function notifyFollowsOfPublishedPackage(input: {
	env: Env
	ownerId: string
	packageId: string
	previousCommit: string | null
	publishedCommit: string
	publishedAt: string
	listing?: {
		listingId: string
		previous: CommunityListingRelease
		current: CommunityListingRelease
	} | null
}): Promise<void> {
	if (!hasAppDb(input.env.APP_DB)) return
	if (input.previousCommit === input.publishedCommit) return
	const listing = input.listing
	if (
		listing &&
		listing.previous.pinnedCommit !== listing.current.pinnedCommit
	) {
		try {
			await deliverListingForkAliases({
				env: input.env,
				listingId: listing.listingId,
				previous: listing.previous,
				current: listing.current,
				publishedAt: input.publishedAt,
			})
		} catch (error) {
			console.error('follow-fork-alias-failed', input.packageId, error)
		}
	}
	try {
		const follows = await listActiveFollowsByTarget(input.env.APP_DB, {
			targetKind: 'package',
			targetId: input.packageId,
		})
		if (follows.length === 0) return
		await deliverFollowRecords({
			env: input.env,
			follows,
			now: new Date(input.publishedAt),
			published: {
				previousCommit: input.previousCommit,
				publishedCommit: input.publishedCommit,
				publishedAt: input.publishedAt,
			},
		})
	} catch (error) {
		console.error('follow-published-notify-failed', input.packageId, error)
	}
}
