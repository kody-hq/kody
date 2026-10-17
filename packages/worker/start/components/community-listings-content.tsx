/** @jsxImportSource @emotion/react */
import { mergeCss } from './merge-css.ts'
import { SiteLink } from './site-link.tsx'
/** @jsxRuntime automatic */
import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import { type PublicCommunityListing } from '#universal/community-public-types.ts'
import {
	communityPackageCategoryCopy,
	countCommunityListingsByCategory,
	visibleCommunityBrowseCategories,
	type CommunityCategoryCounts,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityPublishedDate,
} from '#universal/community-display.ts'
import { renderCommunityEmptyState } from './community-empty-state.tsx'
import { CommunityListingIcon } from './community-listing-icon.tsx'
import {
	FORKED_COPY_TOOLTIP,
	FORK_OUTDATED_COPY_TOOLTIP,
	renderCopyPromptPill,
	renderForkAheadPill,
} from './fork-outdated-copy-button.tsx'
import { getCommunityListingHref } from '#universal/community-links.ts'
import { renderCommunityListingName } from './community-listing-name.tsx'
import { communityStatusPillBoxCss } from '#universal/community-status-pill.ts'
import {
	buildCommunityIndexHref,
	defaultCommunityListingSort,
	type CommunityListingSort,
} from '#universal/community-search.ts'
import { type CommunityIndexGroup } from '#universal/loader-data.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import {
	getSurfaceCardCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Server-rendered community listings (the `community-listings` frame),
 * restyled to the redesign prototype's `.pkg-grid` / `.pkg-card` grammar
 * (`landing/community.html`). This HTML is injected by the frame mechanism —
 * no client component hydrates here, so the card entrance is a pure CSS
 * animation (gated on `html.js` + reduced-motion) that replays whenever the
 * frame loads or reloads, with a per-card stagger set inline by the server.
 */

export type CommunityListingsContentProps = {
	listings: Array<PublicCommunityListing>
	groups?: Array<CommunityIndexGroup> | null
	categoryCounts?: CommunityCategoryCounts | null
	query: string | null
	sort?: CommunityListingSort
	category?: CommunityListingCategory | null
}

function formatCount(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function communitySortHint(sort: CommunityListingSort) {
	switch (sort) {
		case 'newest':
			return 'Newest first — last published, including updates.'
		case 'best':
			return 'Best first — ratings, then recency.'
		default: {
			const exhaustive: never = sort
			throw new Error(`Unhandled community listing sort: ${String(exhaustive)}`)
		}
	}
}

function renderCommunityBrowseToolbar(input: {
	query: string | null
	sort: CommunityListingSort
	category: CommunityListingCategory | null
	visibleCategories: Array<CommunityListingCategory>
	showCategoryNav: boolean
	showSort: boolean
}) {
	if (!input.showCategoryNav && !input.showSort) return null
	return (
		<div css={browseToolbarCss}>
			{input.showCategoryNav ? (
				<nav
					aria-label="Filter public packages by category"
					data-testid="community-listings-categories"
					css={categoryNavCss}
				>
					<SiteLink
						href={buildCommunityIndexHref({
							query: input.query,
							sort: input.sort,
						})}
						aria-current={input.category == null ? 'page' : undefined}
						css={sortLinkCss}
					>
						All
					</SiteLink>
					{input.visibleCategories.map((category) => (
						<SiteLink
							key={category}
							href={buildCommunityIndexHref({
								query: input.query,
								sort: input.sort,
								category,
							})}
							aria-current={input.category === category ? 'page' : undefined}
							title={communityPackageCategoryCopy[category].description}
							css={sortLinkCss}
						>
							{communityPackageCategoryCopy[category].label}
						</SiteLink>
					))}
				</nav>
			) : null}
			{input.showSort ? (
				<nav
					aria-label="Sort public packages"
					data-testid="community-listings-sort"
					css={sortToolbarCss}
				>
					<p css={sortHintCss}>{communitySortHint(input.sort)}</p>
					<div role="group" aria-label="Sort order" css={sortGroupCss}>
						<SiteLink
							href={buildCommunityIndexHref({
								query: input.query,
								sort: 'best',
								category: input.category,
							})}
							aria-current={input.sort === 'best' ? 'page' : undefined}
							css={sortLinkCss}
						>
							Best
						</SiteLink>
						<SiteLink
							href={buildCommunityIndexHref({
								query: input.query,
								sort: 'newest',
								category: input.category,
							})}
							aria-current={input.sort === 'newest' ? 'page' : undefined}
							title="Last published first, including republished updates"
							css={sortLinkCss}
						>
							Newest
						</SiteLink>
					</div>
				</nav>
			) : null}
		</div>
	)
}

function renderCommunityListingCard(
	listing: PublicCommunityListing,
	index: number,
	options?: { showCategory?: boolean },
) {
	return (
		<li
			key={listing.id}
			style={
				{ '--reveal-delay': `${Math.min(index, 5) * 60}ms` } as CSSProperties
			}
			css={listingCardCss}
		>
			<div css={listingHeadCss}>
				<CommunityListingIcon listing={listing} size="card" />
				<div css={listingTitleBlockCss}>
					<h2 css={listingNameCss}>
						<SiteLink
							href={getCommunityListingHref({
								listingId: listing.id,
								listingName: listing.name,
								kodyId: listing.kodyId,
							})}
							css={listingLinkCss}
						>
							{renderCommunityListingName(listing.name)}
						</SiteLink>
					</h2>
					{listing.trusted || listing.viewerInstall ? (
						<span css={listingBadgeGroupCss}>
							{listing.trusted ? (
								<span
									data-testid={`community-listing-trusted-${listing.id}`}
									title="An admin reviewed this exact version and marked it trusted."
									css={communityBadgePillCss}
								>
									Trusted
								</span>
							) : null}
							{renderCommunityViewerInstallBadge({ listing })}
						</span>
					) : null}
				</div>
			</div>
			<p
				css={listingDescriptionCss}
				data-testid={`community-listing-description-${listing.id}`}
			>
				{listing.description}
			</p>
			{listing.tags.length > 0 || options?.showCategory ? (
				<ul aria-label="Tags" css={communityTagListCss}>
					{options?.showCategory ? (
						<li
							data-testid={`community-listing-category-${listing.id}`}
							css={communityTagPillCss}
						>
							{communityPackageCategoryCopy[listing.category].label}
						</li>
					) : null}
					{listing.tags.map((tag) => (
						<li key={tag} css={communityTagPillCss}>
							{tag}
						</li>
					))}
				</ul>
			) : null}
			<p css={statsCss}>
				{listing.ratingCount > 0 ? (
					/*
					 * Every other stat in this row says what it is
					 * ("12 forks", "effort …"), but the
					 * rating is a glyph and two bare numbers, which
					 * announced as "black star 4.5 (12)". The glyph is
					 * decorative and the numbers get a spoken label.
					 */
					<span css={ratingCss}>
						<span aria-hidden="true" css={ratingStarCss}>
							★
						</span>
						<span css={visuallyHiddenCss}>
							{listing.averageStars == null
								? `not yet rated, ${formatCount(listing.ratingCount, 'rating')}`
								: `rated ${listing.averageStars.toFixed(1)} out of 5 from ${formatCount(listing.ratingCount, 'rating')}`}
						</span>
						<span aria-hidden="true">
							{' '}
							{listing.averageStars == null
								? '—'
								: listing.averageStars.toFixed(1)}{' '}
							({listing.ratingCount})
						</span>
					</span>
				) : (
					<span>No ratings yet</span>
				)}
				<span data-testid={`community-listing-forks-${listing.id}`}>
					{formatCount(listing.forkCount, 'fork')}
				</span>
				{listing.version ? (
					<span data-testid={`community-listing-version-${listing.id}`}>
						<span css={visuallyHiddenCss}>Version </span>
						{listing.version}
					</span>
				) : null}
				<span
					data-testid={`community-listing-published-${listing.id}`}
					title={`Last published ${formatCommunityPublishedDate(listing.publishedAt)}`}
				>
					<span css={visuallyHiddenCss}>Published </span>
					{formatCommunityPublishedDate(listing.publishedAt)}
				</span>
				{listing.averageAdaptationEffort == null ? null : (
					<span>
						effort{' '}
						{formatCommunityAdaptationEffort(listing.averageAdaptationEffort)}
					</span>
				)}
			</p>
		</li>
	)
}

function renderCommunityListingGrid(
	listings: Array<PublicCommunityListing>,
	options?: { showCategory?: boolean },
) {
	return (
		<ul css={listingGridCss}>
			{listings.map((listing, index) =>
				renderCommunityListingCard(listing, index, options),
			)}
		</ul>
	)
}

/** Card-only: on the detail page these live in the repository action group. */
function renderCommunityViewerInstallBadge(input: {
	listing: PublicCommunityListing
}) {
	const install = input.listing.viewerInstall
	if (install?.listingAhead && install.listingAheadPrompt) {
		return renderCopyPromptPill({
			label: 'Fork outdated',
			prompt: install.listingAheadPrompt,
			testId: `community-listing-ahead-${input.listing.id}`,
			tooltip: FORK_OUTDATED_COPY_TOOLTIP,
			tone: 'outdated',
			href: install.listingDiffHref,
		})
	}
	if (install?.forkAhead && install.listingDiffHref) {
		return renderForkAheadPill({
			href: install.listingDiffHref,
			testId: `community-listing-fork-ahead-${input.listing.id}`,
		})
	}
	if (install) {
		const testId = `community-listing-viewer-install-${input.listing.id}`
		if (install.status === 'installed') {
			return (
				<span data-testid={testId} css={communityViewerInstallStatusCss}>
					Installed
				</span>
			)
		}
		return renderCopyPromptPill({
			label: 'Forked',
			prompt: install.agentPrompt,
			testId,
			tooltip: FORKED_COPY_TOOLTIP,
			tone: 'badge',
		})
	}
	return null
}

export function CommunityListingsContent(props: CommunityListingsContentProps) {
	const { listings, query } = props
	const sort = props.sort ?? defaultCommunityListingSort
	const category = props.category ?? null
	const groups = props.groups ?? null
	const categoryCounts =
		props.categoryCounts ?? countCommunityListingsByCategory(listings)
	const visibleCategories = visibleCommunityBrowseCategories({
		counts: categoryCounts,
		selected: category,
	})
	const emptyCatalog =
		listings.length === 0 && query == null && category == null
	const showCategoryNav = visibleCategories.length > 0 || category != null
	const showSort = !emptyCatalog

	return (
		<div data-testid="community-listings-frame">
			{renderCommunityBrowseToolbar({
				query,
				sort,
				category,
				visibleCategories,
				showCategoryNav,
				showSort,
			})}
			{listings.length === 0 ? (
				renderCommunityEmptyState(query, sort, category)
			) : groups != null && groups.length > 0 ? (
				<div data-testid="community-listings-overview" css={overviewCss}>
					{groups.map((group) => {
						const label = communityPackageCategoryCopy[group.category].label
						const hasMore = group.total > group.listings.length
						return (
							<section
								key={group.category}
								aria-labelledby={`community-category-${group.category}`}
								css={overviewSectionCss}
							>
								<header css={overviewHeadCss}>
									<div>
										<h2
											id={`community-category-${group.category}`}
											css={overviewTitleCss}
										>
											{label}
										</h2>
										<p css={overviewHintCss}>
											{communityPackageCategoryCopy[group.category].description}
										</p>
									</div>
									{hasMore ? (
										<SiteLink
											href={buildCommunityIndexHref({
												query,
												sort,
												category: group.category,
											})}
											css={overviewSeeAllCss}
										>
											See all {label}
										</SiteLink>
									) : null}
								</header>
								{renderCommunityListingGrid(group.listings)}
							</section>
						)
					})}
				</div>
			) : (
				renderCommunityListingGrid(listings, { showCategory: query != null })
			)}
		</div>
	)
}

/* ---------- styles ---------- */

const browseToolbarCss = {
	margin: 'clamp(2.2rem, 5vw, 3.5rem) 0 0',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.9rem',
} satisfies CSSObject

const categoryNavCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.4rem',
	'& a': {
		display: 'inline-flex',
		alignItems: 'center',
		minHeight: '44px',
		backgroundColor: colors.surface,
		border: `1.5px solid ${colors.border}`,
		borderRadius: '999px',
		padding: '0.35rem 0.85rem',
	},
} satisfies CSSObject

const sortToolbarCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '0.8rem 1.2rem',
	flexWrap: 'wrap' as const,
} satisfies CSSObject

const overviewCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: 'clamp(1.8rem, 4vw, 2.6rem)',
	marginTop: '1rem',
} satisfies CSSObject

const overviewSectionCss = {
	minWidth: 0,
} satisfies CSSObject

const overviewHeadCss = {
	display: 'flex',
	alignItems: 'flex-end',
	justifyContent: 'space-between',
	gap: '0.8rem 1.2rem',
	flexWrap: 'wrap' as const,
	marginBottom: '0.85rem',
} satisfies CSSObject

const overviewTitleCss = {
	margin: 0,
	fontSize: '1.15rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
} satisfies CSSObject

const overviewHintCss = {
	margin: '0.25rem 0 0',
	color: colors.textMuted,
	fontSize: '0.88rem',
} satisfies CSSObject

const overviewSeeAllCss = {
	color: colors.primaryText,
	fontSize: '0.9rem',
	fontWeight: 650,
	textUnderlineOffset: '0.18em',
	whiteSpace: 'nowrap' as const,
} satisfies CSSObject

const sortHintCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
} satisfies CSSObject

const sortGroupCss = {
	display: 'inline-flex',
	alignItems: 'stretch',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.2rem',
} satisfies CSSObject

const sortLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	minHeight: '44px',
	padding: '0.3rem 0.95rem',
	borderRadius: '999px',
	color: colors.textMuted,
	fontSize: '0.88rem',
	fontWeight: 650,
	lineHeight: 1.2,
	textDecoration: 'none',
	transition: `background-color 140ms ${transitions.easeOut}, color 140ms ${transitions.easeOut}`,
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		backgroundColor: colors.primarySoft,
		color: colors.primaryText,
	},
} satisfies CSSObject

const listingGridCss = {
	listStyle: 'none',
	margin: '1rem 0 0',
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(19rem, 100%), 1fr))',
	gap: '1rem',
} satisfies CSSObject

/* Surface card with green hover border + lift; whole card is the target via
   the stretched name link. Entrance reuses the shared `card-in` keyframes
   from public/styles.css (declared inside the same reduced-motion media
   block), staggered by the inline `--reveal-delay`. */
const listingCardCss = mergeCss(getSurfaceCardCss({ interactive: true }), {
	position: 'relative' as const,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.8rem',
	padding: '1.3rem 1.4rem',
	'@media (prefers-reduced-motion: no-preference)': {
		':root.js &': {
			animation: `card-in 600ms ${transitions.easeOut} var(--reveal-delay, 0ms) backwards`,
		},
	},
})

const listingHeadCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: '0.7rem',
} satisfies CSSObject

const listingTitleBlockCss = {
	minWidth: 0,
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.4rem',
} satisfies CSSObject

const listingNameCss = {
	margin: 0,
	fontSize: '1.12rem',
	fontWeight: 720,
	letterSpacing: '-0.012em',
	lineHeight: 1.2,
	overflowWrap: 'anywhere' as const,
	minWidth: 0,
} satisfies CSSObject

/* The whole card is the target; the link just names it. */
const listingLinkCss = {
	color: colors.text,
	textDecoration: 'none',
	transition: `color 140ms ${transitions.easeOut}`,
	'&:hover': {
		color: colors.primaryText,
	},
	'&::after': {
		content: '""',
		position: 'absolute' as const,
		inset: 0,
	},
} satisfies CSSObject

const communityViewerInstallStatusCss = {
	...communityStatusPillBoxCss,
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
} satisfies CSSObject

/* The prototype's `.badge-trusted` pill; the detail head reuses it without
   the card's trailing-edge push. Same box as Install / Installed. */
const communityBadgePillCss = {
	...communityStatusPillBoxCss,
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
	cursor: 'help',
} satisfies CSSObject

const listingBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
} satisfies CSSObject

const listingDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.55,
	textWrap: 'balance' as const,
} satisfies CSSObject

/* Hairline tag chips (`.pkg-tags`), shared with the detail head. */
const communityTagListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
} satisfies CSSObject

const communityTagPillCss = {
	fontSize: '0.8rem',
	fontWeight: 550,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.1rem 0.6rem',
} satisfies CSSObject

/* Stats sit on the card floor, over a top hairline. */
const statsCss = {
	margin: 'auto 0 0',
	paddingTop: '0.8rem',
	borderTop: `1px solid ${colors.border}`,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.3rem 1.1rem',
	fontSize: '0.88rem',
	color: colors.textMuted,
	'& span': {
		whiteSpace: 'nowrap' as const,
	},
} satisfies CSSObject

const ratingCss = {
	color: colors.text,
	fontWeight: 600,
} satisfies CSSObject

const ratingStarCss = {
	color: colors.primaryText,
} satisfies CSSObject
