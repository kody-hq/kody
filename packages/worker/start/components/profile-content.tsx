/** @jsxImportSource @emotion/react */
import { SiteLink } from './site-link.tsx'
/** @jsxRuntime automatic */
import { type CSSObject } from '@emotion/react'

import {
	communityActivityVerb,
	formatCommunityActivityDate,
} from '#universal/community-activity-display.ts'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'
import { renderCommunityListingName } from './community-listing-name.tsx'
import { IdentityIconMark } from './identity-icon-mark.tsx'
import {
	type ProfilePackageAppFilter,
	type ProfilePackageFilters,
	type ProfilePackageHiddenFilter,
	type ProfilePackageListingFilter,
	type ProfilePackagePresenceFilter,
	type ProfilePackageSort,
	type ProfilePackageSortDirection,
	type ProfilePackageVisibilityFilter,
	type PublicCommunityActivityItem,
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import { renderIcon, type IconName } from './icon.tsx'
import {
	buildProfileHref,
	defaultProfilePackageSortDirection,
	filterProfilePackages,
	profilePackageFiltersAreActive,
	profilePackageSortIsActive,
} from '#universal/profile-search.ts'
import { routes } from '#universal/routes.ts'
import { UserAvatar } from './user-avatar.tsx'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	hoverMq,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'

export type ProfileContentProps = {
	basePath?: string
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	activity: Array<PublicCommunityActivityItem> | null
	query: string | null
	visibility?: ProfilePackageVisibilityFilter
	listing?: ProfilePackageListingFilter
	hidden?: ProfilePackageHiddenFilter
	app?: ProfilePackageAppFilter
	package?: ProfilePackagePresenceFilter
	sort?: ProfilePackageSort
	dir?: ProfilePackageSortDirection
	isSelf: boolean
	/** Server already applied `q` (capped inventory). Do not AND-filter again. */
	queryAppliedByLoader?: boolean
}

function renderForkIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="12" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<circle cx="18" cy="6" r="3" />
			<path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
			<path d="M12 12v3" />
		</svg>
	)
}

/**
 * Package cards carry two unrelated timestamps: the community listing's
 * published_at and the owner's local saved-package edit time. Only the
 * published date lines up with the activity feed. Owners see a republish
 * reminder when the listing pin is behind the package published commit,
 * not when `updated_at` lands after `published_at` from the same publish.
 */
function renderProfilePackageDates(
	pkg: PublicProfilePackageItem,
	options: { isSelf: boolean },
) {
	if (!pkg.communityPublishedAt) {
		return `Edited ${formatCommunityPublishedDate(pkg.updatedAt)}`
	}
	const published = `Published ${formatCommunityPublishedDate(pkg.communityPublishedAt)}`
	if (!options.isSelf || !pkg.needsRepublish) return published
	return `${published} · edited ${formatCommunityPublishedDate(pkg.updatedAt)}, not republished`
}

type ProfileFilterChoice<Filter extends string> = {
	value: Filter
	label: string
	title?: string
}

function renderProfileFilterNav<Filter extends string>(input: {
	label: string
	ariaLabel: string
	testId: string
	selected: Filter
	choices: Array<ProfileFilterChoice<Filter>>
	hrefFor: (value: Filter) => string
}) {
	return (
		<nav
			aria-label={input.ariaLabel}
			data-testid={input.testId}
			css={filterNavCss}
		>
			<span aria-hidden="true" css={filterNavLabelCss}>
				{input.label}
			</span>
			{input.choices.map((choice) => (
				<SiteLink
					key={choice.value}
					href={input.hrefFor(choice.value)}
					aria-current={input.selected === choice.value ? 'page' : undefined}
					title={choice.title}
					data-prevent-scroll-reset
					css={filterLinkCss}
				>
					{choice.label}
				</SiteLink>
			))}
		</nav>
	)
}

/**
 * GET filter pills above the package list, in the same grammar as the
 * community category chips. Every link carries the other active filters and
 * the search query so narrowing one axis never resets another. Guests only
 * get listing, package, app, and sort; visibility, hidden, and "needs
 * republish" describe owner-only inventory the client ignores for them anyway.
 */
function renderProfilePackageFilters(input: {
	basePath?: string
	username: string
	filters: ProfilePackageFilters
	isSelf: boolean
	filtersActive: boolean
}) {
	const { username, filters, isSelf, basePath } = input
	const listingChoices: Array<
		ProfileFilterChoice<ProfilePackageListingFilter>
	> = [
		{ value: 'all', label: 'All' },
		{ value: 'published', label: 'Published' },
		{ value: 'unpublished', label: 'Not published' },
	]
	if (isSelf) {
		listingChoices.push({
			value: 'ahead',
			label: 'Needs republish',
			title:
				'Published packages whose listing pin is behind the latest published commit',
		})
	}
	return (
		<details
			data-testid="profile-package-filters"
			open={input.filtersActive ? true : undefined}
			css={filterDetailsCss}
		>
			<summary css={filterSummaryCss}>Filters</summary>
			<div css={filterToolbarCss}>
				{isSelf
					? renderProfileFilterNav<ProfilePackageVisibilityFilter>({
							label: 'Visibility',
							ariaLabel: 'Filter repositories by visibility',
							testId: 'profile-package-filter-visibility',
							selected: filters.visibility,
							choices: [
								{ value: 'all', label: 'All' },
								{ value: 'public', label: 'Public' },
								{ value: 'private', label: 'Private' },
							],
							hrefFor: (visibility) =>
								buildProfileHref({
									basePath,
									username,
									...filters,
									visibility,
								}),
						})
					: null}
				{renderProfileFilterNav<ProfilePackageListingFilter>({
					label: 'Listing',
					ariaLabel:
						'Filter repositories by whether they are published to Community',
					testId: 'profile-package-filter-listing',
					selected: filters.listing,
					choices: listingChoices,
					hrefFor: (listing) =>
						buildProfileHref({ basePath, username, ...filters, listing }),
				})}
				{isSelf
					? renderProfileFilterNav<ProfilePackageHiddenFilter>({
							label: 'Hidden',
							ariaLabel: 'Filter repositories by hidden state',
							testId: 'profile-package-filter-hidden',
							selected: filters.hidden,
							choices: [
								{ value: 'all', label: 'All' },
								{ value: 'yes', label: 'Hidden' },
								{ value: 'no', label: 'Visible' },
							],
							hrefFor: (hidden) =>
								buildProfileHref({ basePath, username, ...filters, hidden }),
						})
					: null}
				{renderProfileFilterNav<ProfilePackagePresenceFilter>({
					label: 'Package',
					ariaLabel: 'Filter repositories by whether they have a package',
					testId: 'profile-package-filter-package',
					selected: filters.package,
					choices: [
						{ value: 'all', label: 'All' },
						{ value: 'yes', label: 'Has package' },
						{ value: 'no', label: 'No package' },
					],
					hrefFor: (packagePresence) =>
						buildProfileHref({
							basePath,
							username,
							...filters,
							package: packagePresence,
						}),
				})}
				{renderProfileFilterNav<ProfilePackageAppFilter>({
					label: 'App',
					ariaLabel: 'Filter repositories by whether they have an app',
					testId: 'profile-package-filter-app',
					selected: filters.app,
					choices: [
						{ value: 'all', label: 'All' },
						{ value: 'yes', label: 'Has app' },
						{ value: 'no', label: 'No app' },
					],
					hrefFor: (app) =>
						buildProfileHref({ basePath, username, ...filters, app }),
				})}
				{renderProfileFilterNav<ProfilePackageSort>({
					label: 'Sort',
					ariaLabel: 'Sort repositories',
					testId: 'profile-package-sort',
					selected: filters.sort,
					choices: [
						{ value: 'updated', label: 'Updated' },
						{ value: 'created', label: 'Created' },
						{ value: 'name', label: 'Name' },
					],
					hrefFor: (sort) =>
						buildProfileHref({
							basePath,
							username,
							...filters,
							sort,
							dir: defaultProfilePackageSortDirection(sort),
						}),
				})}
				{renderProfileFilterNav<ProfilePackageSortDirection>({
					label: 'Order',
					ariaLabel: 'Sort direction',
					testId: 'profile-package-sort-dir',
					selected: filters.dir,
					choices: [
						{ value: 'asc', label: 'Ascending' },
						{ value: 'desc', label: 'Descending' },
					],
					hrefFor: (dir) =>
						buildProfileHref({ basePath, username, ...filters, dir }),
				})}
			</div>
		</details>
	)
}

function countNoun(count: number, singular: string, plural: string) {
	return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

function renderProfilePackageSignifiers(pkg: PublicProfilePackageItem) {
	const hasCommunityListing = pkg.communityListingId != null
	const signifiers: Array<{ name: IconName; title: string; show: boolean }> = [
		{ name: 'box', title: 'Package', show: pkg.hasPackage },
		{ name: 'folder', title: 'Repo', show: !pkg.hasPackage },
		{
			name: 'lock',
			title: 'Private',
			show: pkg.isPrivate === true,
		},
		{
			name: 'eye',
			title: 'Hidden',
			show: pkg.hidden === true,
		},
		{
			name: 'share',
			title: 'Published to community',
			show: hasCommunityListing,
		},
		{
			name: 'inbox',
			title: 'Not published to Community',
			show: pkg.hasPackage && !hasCommunityListing && pkg.isPrivate !== true,
		},
		{
			name: 'cloud',
			title: countNoun(pkg.webhookCount, 'webhook', 'webhooks'),
			show: pkg.webhookCount > 0,
		},
		{
			name: 'briefcase',
			title: countNoun(pkg.jobCount, 'job', 'jobs'),
			show: pkg.jobCount > 0,
		},
		{ name: 'globe', title: 'Has an app', show: pkg.hasApp },
	]
	return (
		<span data-testid="profile-package-signifiers" css={packageSignifiersCss}>
			{signifiers
				.filter((signifier) => signifier.show)
				.map((signifier) => (
					<span
						key={signifier.name}
						title={signifier.title}
						data-signifier={signifier.name}
						css={packageSignifierCss}
					>
						{renderIcon(signifier.name, {
							size: '0.95em',
							title: signifier.title,
						})}
					</span>
				))}
		</span>
	)
}

function renderProfilePackagesEmptyCopy(input: {
	query: string | null
	filtersActive: boolean
	hasLoadedPackages: boolean
	isSelf: boolean
}) {
	if (input.filtersActive && input.hasLoadedPackages) {
		return 'No repositories matched these filters.'
	}
	if (input.query) return 'No repositories matched your search.'
	if (input.filtersActive) return 'No repositories matched these filters.'
	return input.isSelf
		? 'You have no repositories yet.'
		: 'No public repositories to take yet.'
}

export function ProfileContent(props: ProfileContentProps) {
	const { profile, packages, activity, query, isSelf } = props
	const filters: ProfilePackageFilters = {
		query: query ?? '',
		visibility: props.visibility ?? 'all',
		listing: props.listing ?? 'all',
		hidden: props.hidden ?? 'all',
		app: props.app ?? 'all',
		package: props.package ?? 'all',
		sort: props.sort ?? 'updated',
		dir: props.dir ?? 'desc',
	}
	const filtersActive = profilePackageFiltersAreActive(filters)
	const toolbarActive = filtersActive || profilePackageSortIsActive(filters)
	const visiblePackages = filterProfilePackages(packages, {
		...filters,
		query: props.queryAppliedByLoader ? '' : filters.query,
	})
	const showFilters =
		isSelf || packages.length > 0 || Boolean(query) || toolbarActive

	return (
		<div data-testid="profile-frame">
			<section css={sectionCss} data-testid="profile-packages">
				{showFilters
					? renderProfilePackageFilters({
							username: profile.username,
							basePath: props.basePath,
							filters,
							isSelf,
							filtersActive: toolbarActive,
						})
					: null}
				{visiblePackages.length === 0 ? (
					<p css={emptyCss} data-testid="profile-packages-empty">
						{renderProfilePackagesEmptyCopy({
							query,
							filtersActive,
							hasLoadedPackages: packages.length > 0,
							isSelf,
						})}
					</p>
				) : (
					<ul css={packageListCss}>
						{visiblePackages.map((pkg) => {
							const packageHref =
								pkg.canOpenDetail !== false
									? routes.communityPackage.href({
											username: profile.username,
											kodyId: pkg.communityListingKodyId ?? pkg.kodyId,
										})
									: null
							const listingHref = pkg.communityListingId
								? getCommunityListingHref({
										listingId: pkg.communityListingId,
										ownerUsername: profile.username,
										kodyId: pkg.communityListingKodyId,
									})
								: null
							return (
								<li key={pkg.kodyId} css={cardCss}>
									<div css={packageHeadingCss}>
										<IdentityIconMark
											name={pkg.name}
											iconUrl={pkg.iconUrl}
											size="card"
											testId="profile-package-icon"
										/>
										<div css={packageTitleGroupCss}>
											{listingHref ? (
												<SiteLink
													href={listingHref}
													title="fork"
													aria-label="fork"
													css={forkButtonCss}
												>
													{renderForkIcon()}
												</SiteLink>
											) : null}
											<h3 css={packageNameCss}>
												{packageHref ? (
													<SiteLink href={packageHref} css={packageNameLinkCss}>
														{renderCommunityListingName(pkg.name)}
													</SiteLink>
												) : (
													<span data-testid="profile-package-name-nolink">
														{renderCommunityListingName(pkg.name)}
													</span>
												)}
											</h3>
											{renderProfilePackageSignifiers(pkg)}
										</div>
									</div>
									{pkg.description ? (
										<p css={descriptionCss}>{pkg.description}</p>
									) : null}
									{pkg.tags.length > 0 ? (
										<ul css={tagListCss}>
											{pkg.tags.map((tag) => (
												<li key={tag} css={tagPillCss}>
													{tag}
												</li>
											))}
										</ul>
									) : null}
									<p css={mutedCss}>
										{renderProfilePackageDates(pkg, { isSelf })}
									</p>
								</li>
							)
						})}
					</ul>
				)}
			</section>

			{activity !== null ? (
				<section css={activitySectionCss} data-testid="profile-activity">
					<h2 css={sectionTitleCss}>Recent activity</h2>
					<p css={mutedCss} data-testid="profile-activity-hint">
						Community publishes and forks. Editing a repository without
						republishing it does not appear here.
					</p>
					{activity.length === 0 ? (
						<p css={descriptionCss}>No public activity yet.</p>
					) : (
						<ul css={activityListCss}>
							{activity.map((item) => (
								<li
									key={`${item.type}:${item.listingId}:${item.createdAt}`}
									css={activityItemCss}
								>
									<span css={activityActorCss}>
										<UserAvatar
											displayName={item.actorDisplayName}
											avatarUrl={item.actorAvatarUrl}
											size={32}
										/>
										<span>
											{communityActivityVerb(item.type)}{' '}
											<SiteLink
												href={getCommunityListingHref({
													listingId: item.listingId,
													listingName: item.listingName,
													kodyId: item.listingKodyId,
												})}
												css={mutedLinkCss}
											>
												{item.listingName}
											</SiteLink>
										</span>
									</span>
									<time
										dateTime={item.createdAt}
										css={mutedCss}
										title={item.createdAt}
									>
										{formatCommunityActivityDate(item.createdAt)}
									</time>
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}
		</div>
	)
}

const activityActorCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.sm,
} satisfies CSSObject

const sectionCss = {
	display: 'grid',
	gap: spacing.md,
} satisfies CSSObject

const filterDetailsCss = {
	margin: 0,
} satisfies CSSObject

const filterSummaryCss = {
	cursor: 'pointer',
	color: colors.textMuted,
	fontSize: '0.8rem',
	fontWeight: 600,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
	width: 'fit-content',
	minHeight: '1.75rem',
	display: 'flex',
	alignItems: 'center',
} satisfies CSSObject

const filterToolbarCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.sm,
} satisfies CSSObject

/* Same bordered-pill grammar as the community category chips, sized down. */
const filterNavCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.3rem',
	'& a': {
		display: 'inline-flex',
		alignItems: 'center',
		minHeight: '1.75rem',
		backgroundColor: colors.surface,
		border: `1px solid ${colors.border}`,
		borderRadius: '999px',
		padding: '0.1rem 0.5rem',
	},
} satisfies CSSObject

const filterNavLabelCss = {
	color: colors.textMuted,
	fontSize: '0.7rem',
	fontWeight: 600,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
	minWidth: '4.5rem',
} satisfies CSSObject

const filterLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	minHeight: '1.75rem',
	padding: '0.1rem 0.55rem',
	borderRadius: '999px',
	color: colors.textMuted,
	fontSize: '0.75rem',
	fontWeight: 650,
	lineHeight: 1.2,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		backgroundColor: colors.primarySoft,
		borderColor: colors.primarySoft,
		color: colors.primaryText,
	},
} satisfies CSSObject

const activitySectionCss = {
	...sectionCss,
	marginTop: spacing.xl,
} satisfies CSSObject

const emptyCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '42ch',
	textWrap: 'pretty' as const,
} satisfies CSSObject

const sectionTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
} satisfies CSSObject

const packageListCss = {
	display: 'grid',
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
} satisfies CSSObject

const packageHeadingCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
} satisfies CSSObject

const packageTitleGroupCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
	flex: '1 1 auto',
} satisfies CSSObject

const packageSignifiersCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3rem',
	flex: 'none',
	color: colors.textMuted,
} satisfies CSSObject

const packageSignifierCss = {
	display: 'inline-flex',
	alignItems: 'center',
	lineHeight: 0,
} satisfies CSSObject

const packageNameCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
	minWidth: 0,
} satisfies CSSObject

const packageNameLinkCss = {
	color: 'inherit',
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
} satisfies CSSObject

const forkButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: 'none',
	width: '1.75rem',
	height: '1.75rem',
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	textDecoration: 'none',
	transition: `color ${transitions.fast}, border-color ${transitions.fast}, background-color ${transitions.fast}`,
	[hoverMq]: {
		'&:hover': {
			color: colors.primaryText,
			borderColor: colors.primaryText,
			backgroundColor: colors.primarySoftest,
		},
	},
} satisfies CSSObject

const tagListCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.xs,
	margin: 0,
	padding: 0,
	listStyle: 'none',
} satisfies CSSObject

const tagPillCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject

const activityListCss = {
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	listStyle: 'none',
} satisfies CSSObject

const activityItemCss = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
	fontSize: typography.fontSize.sm,
	color: colors.text,
} satisfies CSSObject

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject
