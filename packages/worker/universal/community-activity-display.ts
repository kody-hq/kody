import type { CommunityActivityEventType } from '#universal/community-public-types.ts'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'

export function communityActivityVerb(
	type: CommunityActivityEventType,
): string {
	switch (type) {
		case 'listing_published':
			return 'Published'
		case 'listing_updated':
			return 'Updated'
		case 'listing_forked':
			return 'Forked'
		default: {
			const _exhaustive: never = type
			return _exhaustive
		}
	}
}

export function formatCommunityActivityDate(value: string) {
	return formatCommunityPublishedDate(value)
}
