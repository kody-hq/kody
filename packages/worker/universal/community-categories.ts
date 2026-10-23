export const communityPackageCategories = [
	'integrations',
	'examples',
	'productivity',
	'apps',
	'utilities',
] as const

export type CommunityPackageCategory =
	(typeof communityPackageCategories)[number]

export const communityListingCategories = [
	...communityPackageCategories,
	'other',
] as const

export type CommunityListingCategory =
	(typeof communityListingCategories)[number]

const defaultCommunityListingCategory =
	'other' satisfies CommunityListingCategory

export const communityIndexOverviewLimitPerCategory = 6

/** Newest listings fetched per category before Best/Newest ranking. */
export const communityIndexOverviewCandidateLimitPerCategory = 50

export const communityPackageCategoryCopy: Record<
	CommunityListingCategory,
	{ label: string; description: string }
> = {
	integrations: {
		label: 'Integrations',
		description: 'Helpers for third-party services and APIs.',
	},
	examples: {
		label: 'Examples',
		description: 'Try-this and learning packages.',
	},
	productivity: {
		label: 'Productivity',
		description: 'Personal workflows, planning, and digests.',
	},
	apps: {
		label: 'Apps',
		description: 'Hosted package apps.',
	},
	utilities: {
		label: 'Utilities',
		description: 'Generic helpers that are not a provider or a workflow.',
	},
	other: {
		label: 'Other',
		description: 'Packages that have not been categorized yet.',
	},
}

const communityListingCategorySet = new Set<string>(communityListingCategories)

const inferPriority = [
	'examples',
	'integrations',
	'productivity',
	'apps',
] as const satisfies ReadonlyArray<CommunityPackageCategory>

const categoryTagHints: Record<
	CommunityPackageCategory,
	ReadonlyArray<string>
> = {
	examples: ['zero-auth', 'example', 'examples', 'starter'],
	integrations: [
		'github',
		'discord',
		'spotify',
		'notion',
		'google',
		'origin',
		'slack',
		'youtube',
		'twitter',
		'openai',
		'stripe',
		'linear',
		'gmail',
		'calendar',
		'resend',
	],
	productivity: [
		'meal',
		'grocery',
		'planning',
		'digest',
		'rss',
		'todo',
		'notes',
	],
	apps: ['app', 'apps'],
	utilities: [],
}

function isCommunityListingCategory(
	value: string,
): value is CommunityListingCategory {
	return communityListingCategorySet.has(value)
}

export function parseCommunityListingCategory(
	raw: string | null | undefined,
): CommunityListingCategory | null {
	if (raw == null) return null
	const normalized = raw.trim().toLowerCase()
	return isCommunityListingCategory(normalized) ? normalized : null
}

/** Stored browse category. Invalid or missing values fall back to Other. */
export function readStoredCommunityListingCategory(
	raw: string | null | undefined,
): CommunityListingCategory {
	return parseCommunityListingCategory(raw) ?? defaultCommunityListingCategory
}

export function parseCommunityPackageCategory(
	raw: string | null | undefined,
): CommunityPackageCategory | null {
	const parsed = parseCommunityListingCategory(raw)
	return parsed != null && parsed !== 'other' ? parsed : null
}

export function inferCommunityListingCategoryFromTags(
	tags: ReadonlyArray<string>,
): CommunityPackageCategory | null {
	const normalized = new Set(
		tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0),
	)
	for (const category of inferPriority) {
		if (categoryTagHints[category].some((hint) => normalized.has(hint))) {
			return category
		}
	}
	return null
}

export function resolveCommunityListingCategory(input: {
	category?: string | null
	tags?: ReadonlyArray<string>
}): CommunityListingCategory {
	const explicit = parseCommunityListingCategory(input.category)
	if (explicit != null && explicit !== 'other') return explicit
	return (
		inferCommunityListingCategoryFromTags(input.tags ?? []) ??
		defaultCommunityListingCategory
	)
}

export type CommunityCategoryCounts = Record<CommunityListingCategory, number>

export function emptyCommunityCategoryCounts(): CommunityCategoryCounts {
	return {
		integrations: 0,
		examples: 0,
		productivity: 0,
		apps: 0,
		utilities: 0,
		other: 0,
	}
}

export function countCommunityListingsByCategory<
	T extends { category: CommunityListingCategory },
>(listings: ReadonlyArray<T>): CommunityCategoryCounts {
	const counts = emptyCommunityCategoryCounts()
	for (const listing of listings) {
		counts[listing.category] += 1
	}
	return counts
}

/**
 * Category chips for the current result set. Empty categories stay off the
 * row so a huge catalog does not grow a chip for every unused bucket, and an
 * empty shelf does not offer filters to nowhere. The selected category stays
 * visible so a deep link can still show where you are.
 */
export function visibleCommunityBrowseCategories(input: {
	counts: CommunityCategoryCounts
	selected?: CommunityListingCategory | null
}): Array<CommunityListingCategory> {
	return communityListingCategories.filter((category) => {
		return category === input.selected || input.counts[category] > 0
	})
}

export function groupCommunityListingsByCategory<
	T extends { category: CommunityListingCategory },
>(
	listings: ReadonlyArray<T>,
	limitPerCategory?: number,
): Array<{
	category: CommunityListingCategory
	listings: Array<T>
	total: number
}> {
	const byCategory = new Map<CommunityListingCategory, Array<T>>()
	for (const listing of listings) {
		const group = byCategory.get(listing.category) ?? []
		group.push(listing)
		byCategory.set(listing.category, group)
	}
	const groups: Array<{
		category: CommunityListingCategory
		listings: Array<T>
		total: number
	}> = []
	for (const category of communityListingCategories) {
		const groupListings = byCategory.get(category)
		if (groupListings == null || groupListings.length === 0) continue
		groups.push({
			category,
			listings:
				limitPerCategory == null
					? groupListings
					: groupListings.slice(0, limitPerCategory),
			total: groupListings.length,
		})
	}
	return groups
}
