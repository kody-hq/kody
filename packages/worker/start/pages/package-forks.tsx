/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { AccountManagementPanel } from './account-management-components.tsx'
import { IdentityIconMark } from '../components/identity-icon-mark.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	PackageRepoTabPanel,
	renderPackageRepoChrome,
} from '../components/package-repo-nav.tsx'
import { detailArticleCss } from '../components/community-detail-sections.tsx'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import {
	type PackageForkView,
	type PackageForksLoaderData,
} from '#universal/package-forks.ts'
import { colors } from '#universal/styles/tokens.ts'
import {
	listCss,
	mutedCopyCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
} from './package-collaborators-parts.tsx'

function forkCountLabel(count: number) {
	return `${count} ${count === 1 ? 'fork' : 'forks'}`
}

export function PackageForksRoute({
	payload,
}: {
	payload: PackageForksLoaderData
}) {
	const { shell, forks, total } = payload
	const { username, kodyId } = shell
	const hidden = total - forks.length
	return (
		<article css={detailArticleCss} data-testid="package-forks">
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate: shell.isPrivate,
				isListed: shell.isListed,
				viewerIsOwner: shell.viewerIsOwner,
				viewerCanManage: shell.viewerCanManage,
				viewerCanManageAccess: shell.viewerCanManageAccess,
				active: 'forks',
				filesHref: getPackageTreeHref({
					username,
					kodyId,
					listingId: shell.listingId,
					ref: shell.defaultBranch || fallbackDefaultBranchName,
				}),
				description: shell.description,
				ownerProfilePublic: shell.ownerProfilePublic,
				iconUrl:
					shell.listingIconUrl ??
					resolvePackageListIconUrl({
						username,
						kodyId,
						listingId: shell.listingId,
						listingIconCommit: null,
						publishedCommit: shell.publishedCommit,
					}),
				iconName: kodyId,
			})}
			<PackageRepoTabPanel>
				<AccountManagementPanel
					title="Forks"
					ariaLabel="Forks"
					description={
						total === 0
							? undefined
							: `${forkCountLabel(total)} you can see. Private forks only show up for people who can open them.`
					}
				>
					{forks.length === 0 ? (
						<p css={mutedCopyCss} data-testid="package-forks-empty">
							{shell.isListed
								? 'No forks you can see yet. Public forks show up here once someone forks this package.'
								: 'This package is not listed publicly, so it has no forks yet.'}
						</p>
					) : (
						<ul css={listCss} data-testid="package-forks-list">
							{forks.map(renderFork)}
						</ul>
					)}
					{hidden > 0 ? (
						<p css={mutedCopyCss} data-testid="package-forks-more">
							Showing the newest {forks.length} of {total}.
						</p>
					) : null}
				</AccountManagementPanel>
			</PackageRepoTabPanel>
		</article>
	)
}

function renderFork(fork: PackageForkView) {
	const owner = fork.ownerDisplayName?.trim() || `@${fork.ownerSlug}`
	return (
		<li
			key={fork.id}
			data-testid="package-fork"
			data-private={fork.isPrivate ? 'true' : undefined}
			css={rowCss}
		>
			<IdentityIconMark name={fork.name} iconUrl={fork.iconUrl} size="card" />
			<span css={rowTextCss}>
				<span css={rowNameCss}>
					<SiteLink href={fork.href} css={forkNameLinkCss}>
						{fork.name}
					</SiteLink>
					{fork.isPrivate ? (
						<span css={privateBadgeCss} data-testid="package-fork-private">
							{renderIcon('lock', { size: '0.85em' })}
							Private
						</span>
					) : null}
				</span>
				{fork.description ? (
					<span css={rowDetailCss}>{fork.description}</span>
				) : null}
				<span css={rowDetailCss}>
					{renderIcon('git-fork', { size: '0.9em' })} Forked by {owner} on{' '}
					{formatCommunityPublishedDate(fork.createdAt)}
				</span>
			</span>
		</li>
	)
}

const forkNameLinkCss: CSSObject = {
	color: colors.text,
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
		textDecoration: 'underline',
		textUnderlineOffset: '0.18em',
	},
}

const privateBadgeCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3rem',
	marginInlineStart: '0.5rem',
	padding: '0.1rem 0.5rem',
	borderRadius: '999px',
	fontSize: '0.75rem',
	fontWeight: 600,
	verticalAlign: 'middle',
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
}
