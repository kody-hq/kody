/** @jsxImportSource @emotion/react */
/** @jsxRuntime automatic */
import { type CSSProperties } from 'react'
import { SiteLink } from './site-link.tsx'
import { type PublicCommunityListing } from '#universal/community-public-types.ts'
import { communityPackageCategoryCopy } from '#universal/community-categories.ts'
import { buildCommunityIndexHref } from '#universal/community-search.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityPublishedDate,
	formatCommunityStars,
	shortCommunityCommit,
} from '#universal/community-display.ts'
import {
	type PackageRepoActions,
	renderPackageRepoActions,
} from './package-title-actions.tsx'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from './package-repo-nav.tsx'
import { visuallyHiddenCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

/**
 * Server-rendered package head (the `community-detail` frame): GitHub-style
 * icon + `@owner / name` + visibility + Repo/Files/Settings tabs with the
 * repository action group, then the public catalog extras (status badges,
 * category and topics, facts) when a listing exists.
 */

/** GitHub-rendered agent docs for plain repos (not a /docs catalog guide). */
const plainReposPromoteDocsHref =
	'https://github.com/kody-hq/kody/blob/main/docs/use/repos.md#promote-flow'

export type CommunityDetailContentProps = {
	listing: PublicCommunityListing | null
	username: string
	kodyId: string
	description: string
	isPrivate: boolean
	ownerProfilePublic: boolean
	viewerIsOwner: boolean
	viewerCanManage: boolean
	viewerCanManageAccess?: boolean
	repoActions: PackageRepoActions | null
	treeRef?: string
	/** Defaults to true. Plain repos pass false for the Repo mark. */
	hasPackage?: boolean
	/**
	 * Plain repos only (owners/members): root package.json at the indexed
	 * commit. Surfaces promote-to-package guidance — no website promote API.
	 */
	packageShaped?: boolean
	iconUrl?: string | null
}

export function CommunityDetailContent(props: CommunityDetailContentProps) {
	const {
		listing,
		username,
		kodyId,
		description,
		isPrivate,
		ownerProfilePublic,
		viewerIsOwner,
		viewerCanManage,
		viewerCanManageAccess,
		repoActions,
		treeRef,
		hasPackage,
		packageShaped,
		iconUrl,
	} = props
	const markUrl = listing?.iconUrl ?? iconUrl ?? null
	const isPackage = hasPackage !== false
	const showPlainRepoOwnerHints = !isPackage && viewerIsOwner

	const filesHref = getPackageTreeHref({
		username,
		kodyId,
		listingId: listing?.id,
		ref: listing?.defaultBranch ?? treeRef ?? fallbackDefaultBranchName,
	})

	return (
		<div data-testid="community-detail-frame">
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate,
				isListed: listing != null,
				hasPackage: isPackage,
				viewerIsOwner,
				viewerCanManage,
				viewerCanManageAccess,
				active: 'repo',
				filesHref,
				description,
				ownerProfilePublic,
				iconUrl: markUrl,
				iconName: listing?.name ?? kodyId,
				animate: true,
				actions: renderPackageRepoActions(repoActions),
			})}

			{listing
				? renderListingHead({
						listing,
						showSourceAheadStatus:
							listing.sourceAhead === true && !repoActions?.publishHref,
					})
				: null}

			{showPlainRepoOwnerHints
				? renderPlainRepoOwnerHints({
						kodyId,
						packageShaped: packageShaped === true,
					})
				: null}

			{listing ? (
				<>
					<p
						data-rise
						style={{ '--rise': '3' } as CSSProperties}
						data-testid="community-detail-topics"
						css={topicsCss}
					>
						<SiteLink
							href={buildCommunityIndexHref({ category: listing.category })}
							data-testid="community-listing-category"
							css={detailCategoryLinkCss}
						>
							{communityPackageCategoryCopy[listing.category].label}
						</SiteLink>
						{listing.tags.length > 0 ? (
							<>
								<span aria-hidden="true" css={topicSeparatorCss}>
									·
								</span>
								<span css={visuallyHiddenCss}>Topics: </span>
								<span data-testid="community-detail-tags">
									{listing.tags.join(', ')}
								</span>
							</>
						) : null}
					</p>

					<dl
						data-rise
						style={{ '--rise': '4' } as CSSProperties}
						css={metaCss}
					>
						{listing.version ? (
							<div>
								<dt>Version</dt>
								<dd data-testid="community-detail-version">
									{listing.version}
								</dd>
							</div>
						) : null}
						<div>
							<dt>License</dt>
							<dd>{listing.license}</dd>
						</div>
						<div>
							<dt>Published</dt>
							<dd>{formatCommunityPublishedDate(listing.publishedAt)}</dd>
						</div>
						<div>
							<dt>Pinned commit</dt>
							<dd>
								<code>{shortCommunityCommit(listing.pinnedCommit)}</code>
							</dd>
						</div>
						<div>
							<dt>Rating</dt>
							<dd data-testid="community-detail-rating">
								{formatCommunityStars(
									listing.averageStars,
									listing.ratingCount,
								)}
							</dd>
						</div>
						<div>
							<dt>Forks</dt>
							<dd data-testid="community-detail-forks">{listing.forkCount}</dd>
						</div>
						<div>
							<dt>Adaptation effort</dt>
							<dd>
								{formatCommunityAdaptationEffort(
									listing.averageAdaptationEffort,
								)}
							</dd>
						</div>
					</dl>
				</>
			) : null}
		</div>
	)
}

/** Statuses only. Anything clickable belongs in the repository action group. */
function renderListingHead(input: {
	listing: PublicCommunityListing
	showSourceAheadStatus: boolean
}) {
	if (!input.showSourceAheadStatus && !input.listing.featured) return null
	return (
		<header
			data-rise
			style={{ '--rise': '2' } as CSSProperties}
			css={listingHeadCss}
		>
			<div css={listingBadgeGroupCss}>
				{input.showSourceAheadStatus ? (
					<span
						data-testid="community-detail-source-ahead-badge"
						title="Default-branch HEAD is newer than the last package publish. Source at HEAD is already public; runtime still uses the published commit."
						css={badgeCss}
					>
						HEAD ahead of published
					</span>
				) : null}
				{input.listing.featured ? (
					<span
						data-testid="community-detail-featured-badge"
						title="An admin featured this package as an onboarding starter install."
						css={badgeCss}
					>
						Featured
					</span>
				) : null}
			</div>
		</header>
	)
}

const listingHeadCss = {
	marginTop: '1.4rem',
	display: 'flex',
	alignItems: 'flex-start',
	gap: '1.1rem',
}

const listingBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
}

const badgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.15rem 0.55rem',
	borderRadius: '999px',
	fontSize: '0.78rem',
	fontWeight: 600,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
}

function buildPromoteToPackagePrompt(kodyId: string) {
	return `Promote my plain Kody repo "${kodyId}" to a saved package. Open search({ entity: "capability:repoPromoteToPackage" }) if needed, then call repoPromoteToPackage({ name: "${kodyId}" }). Root package.json is already at HEAD.`
}

/**
 * Plain repos have no public smart-HTTP clone URL (that lane is packages /
 * listings only). Owners mint a short-lived Artifacts remote via MCP.
 * Promote is MCP/Open API only — no website mutate endpoint.
 */
function renderPlainRepoOwnerHints(input: {
	kodyId: string
	packageShaped: boolean
}) {
	return (
		<section
			data-rise
			style={{ '--rise': '2' } as CSSProperties}
			data-testid="plain-repo-owner-hints"
			css={plainRepoHintsCss}
		>
			{input.packageShaped ? (
				<details css={plainRepoPromoteCss}>
					<summary css={plainRepoPromoteSummaryCss}>Promote to package</summary>
					<div css={plainRepoPromptPanelCss}>
						<p css={plainRepoHintTextCss}>
							Root <code>package.json</code> is at HEAD. Ask your agent to run{' '}
							<code>repoPromoteToPackage</code>, or follow the{' '}
							<SiteLink
								href={plainReposPromoteDocsHref}
								data-testid="plain-repo-promote-docs"
								rel="noopener noreferrer"
								target="_blank"
							>
								promote docs
							</SiteLink>
							.
						</p>
						<pre
							css={plainRepoPromptCss}
							data-testid="plain-repo-promote-prompt"
						>
							<code>{buildPromoteToPackagePrompt(input.kodyId)}</code>
						</pre>
					</div>
				</details>
			) : null}
			<p data-testid="plain-repo-git-remote-hint" css={plainRepoHintTextCss}>
				Clone or push with a short-lived remote from{' '}
				<code>repoGetGitRemote</code> (plain repos are not on public{' '}
				<code>.git</code> smart HTTP).
			</p>
		</section>
	)
}

const plainRepoHintsCss = {
	marginTop: '1.1rem',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.65rem',
}

const plainRepoPromoteCss = {
	border: `1px solid ${colors.border}`,
	borderRadius: '0.55rem',
	padding: '0.55rem 0.75rem',
	backgroundColor: colors.surface,
}

const plainRepoPromoteSummaryCss = {
	cursor: 'pointer',
	fontWeight: 600,
	fontSize: '0.92rem',
	color: colors.text,
	listStyle: 'none' as const,
	'&::-webkit-details-marker': { display: 'none' },
}

const plainRepoPromptPanelCss = {
	marginTop: '0.65rem',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.55rem',
}

const plainRepoHintTextCss = {
	margin: 0,
	fontSize: '0.88rem',
	lineHeight: 1.45,
	color: colors.textMuted,
	'& code': {
		font: '500 0.84em/1.2 ui-monospace, "SF Mono", Menlo, monospace',
		color: colors.text,
	},
	'& a': {
		color: colors.primaryText,
		fontWeight: 550,
		textDecoration: 'underline',
		textUnderlineOffset: '0.18em',
	},
}

const plainRepoPromptCss = {
	margin: 0,
	padding: '0.65rem 0.75rem',
	borderRadius: '0.45rem',
	backgroundColor: colors.background,
	border: `1px solid ${colors.border}`,
	overflowX: 'auto' as const,
	font: '500 0.8rem/1.4 ui-monospace, "SF Mono", Menlo, monospace',
	color: colors.text,
	whiteSpace: 'pre-wrap' as const,
}

/* Category and topics read as one line of metadata: only the category is a
   link, and nothing here borrows the pill shape the action group uses. */
const topicsCss = {
	margin: '1.1rem 0 0',
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'baseline',
	gap: '0.2rem 0.5rem',
	fontSize: '0.92rem',
	lineHeight: 1.5,
	color: colors.textMuted,
}

const topicSeparatorCss = {
	color: colors.textMuted,
}

const detailCategoryLinkCss = {
	color: colors.primaryText,
	fontWeight: 550,
	textDecoration: 'underline',
	textUnderlineOffset: '0.18em',
	'&:hover': {
		color: colors.text,
	},
}

const metaCss = {
	margin: '1.6rem 0 0',
	padding: '1rem 0',
	borderBlock: `1px solid ${colors.border}`,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.5rem 2rem',
	fontSize: '0.92rem',
	'& > div': {
		display: 'flex',
		gap: '0.45rem',
		alignItems: 'baseline',
	},
	'& dt': {
		margin: 0,
		color: colors.textMuted,
	},
	'& dd': {
		margin: 0,
		color: colors.text,
		fontWeight: 550,
	},
	'& dd code': {
		font: '500 0.88rem/1.2 ui-monospace, "SF Mono", Menlo, monospace',
	},
}
