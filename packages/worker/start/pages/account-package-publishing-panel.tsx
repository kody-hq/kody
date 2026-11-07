/** @jsxImportSource @emotion/react */
import type { ReactNode } from 'react'
import { css } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { shortCommunityCommit } from '#universal/community-display.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import type { AccountPackageDetail } from '#universal/loader-data.ts'

function hasUnpublishedPackageCommit(packageDetail: AccountPackageDetail) {
	if (!packageDetail.pendingCommitKnown) return false
	const pending = packageDetail.pendingCommit
	if (!pending) return false
	return (
		packageDetail.publishedCommit == null ||
		packageDetail.publishedCommit !== pending
	)
}

function liveVersionLabel(packageDetail: AccountPackageDetail) {
	if (packageDetail.publishedVersion) return packageDetail.publishedVersion
	if (packageDetail.publishedCommit) {
		return shortCommunityCommit(packageDetail.publishedCommit)
	}
	return null
}

export function visibilityAudienceCopy(packageDetail: AccountPackageDetail) {
	if (!packageDetail.isPrivate) {
		return 'Anyone can see it on the community'
	}
	if (packageDetail.ownerIsPersonal) {
		return 'Only you can see it'
	}
	return 'People in your organization can see it'
}

function newerChangesCopy(packageDetail: AccountPackageDetail) {
	if (!packageDetail.pendingCommitKnown) {
		return 'Could not check whether HEAD has unpublished changes.'
	}
	if (!hasUnpublishedPackageCommit(packageDetail)) return null
	const since = liveVersionLabel(packageDetail)
	const count = packageDetail.unpublishedChangeCount
	if (count != null && count > 0 && since) {
		return `${count} change${count === 1 ? '' : 's'} since ${since}`
	}
	if (count != null && count > 0) {
		return `${count} unpublished change${count === 1 ? '' : 's'}`
	}
	if (since) return `Newer changes since ${since}`
	return 'Unpublished changes are waiting on HEAD'
}

function primaryPublishLabel(packageDetail: AccountPackageDetail) {
	if (!hasUnpublishedPackageCommit(packageDetail)) {
		return 'Review publish status'
	}
	if (packageDetail.lockedAt) return 'Promote this commit'
	return 'Publish HEAD'
}

function commitApproveHref(approveHref: string, commit: string) {
	return `${approveHref}?commit=${encodeURIComponent(commit)}`
}

function unpublishedCommitCountCopy(packageDetail: AccountPackageDetail) {
	if (!hasUnpublishedPackageCommit(packageDetail)) return null
	const list = packageDetail.unpublishedCommits
	if (!list || list.commits.length === 0) return null
	const count = list.commits.length
	if (list.truncated) return `More than ${count} commits not yet published`
	return `${count} commit${count === 1 ? '' : 's'} not yet published`
}

/**
 * Public release: what is live, what is newer, a commit picker into the
 * approve flow, and a single primary publish/promote action (plus lock /
 * empty states).
 */
export function PackagePublishingPanel(input: {
	ownerUsername: string
	packageDetail: AccountPackageDetail
	headingId?: string
}): ReactNode {
	const { packageDetail, ownerUsername } = input
	const headingId = input.headingId ?? 'package-public-release-heading'
	const liveVersion = liveVersionLabel(packageDetail)
	const commitCount = unpublishedCommitCountCopy(packageDetail)
	const newer = commitCount ?? newerChangesCopy(packageDetail)
	const approveHref = routes.communityPackageApprovePublish.href({
		username: ownerUsername,
		kodyId: packageDetail.kodyId,
	})
	const needsAction =
		!packageDetail.pendingCommitKnown ||
		hasUnpublishedPackageCommit(packageDetail)
	const emptyState =
		packageDetail.pendingCommitKnown &&
		!hasUnpublishedPackageCommit(packageDetail)
	const pickerCommits = hasUnpublishedPackageCommit(packageDetail)
		? (packageDetail.unpublishedCommits?.commits ?? [])
		: []

	return (
		<section
			data-testid="package-publishing-panel"
			aria-labelledby={headingId}
			css={css({
				...getAccentCalloutCss(),
				display: 'grid',
				gap: spacing.sm,
				minWidth: 0,
			})}
		>
			<div css={css({ display: 'grid', gap: spacing.xs })}>
				<h3 id={headingId} css={headingCss}>
					Public release
				</h3>
				<p
					css={css({ margin: 0, color: colors.textMuted })}
					data-testid="package-public-release-intro"
				>
					Choose which version of this package is live.
				</p>
			</div>
			<div css={css({ display: 'grid', gap: spacing.xs })}>
				<p
					css={css({ margin: 0, color: colors.text })}
					data-testid="package-publishing-live"
				>
					{packageDetail.publishedCommit ? (
						<>
							{`Live: ${packageDetail.publishedVersion ? `${packageDetail.publishedVersion}, ` : ''}published commit `}
							<code
								data-testid="package-published-commit"
								title={packageDetail.publishedCommit}
							>
								{shortCommunityCommit(packageDetail.publishedCommit)}
							</code>
							.
						</>
					) : liveVersion ? (
						`Live: ${liveVersion}.`
					) : (
						'Nothing published yet.'
					)}
				</p>
				{newer ? (
					<p
						css={css({ margin: 0, color: colors.textMuted })}
						data-testid="package-publishing-newer"
					>
						{newer}
					</p>
				) : null}
				{emptyState ? (
					<p
						css={css({ margin: 0, color: colors.textMuted })}
						data-testid="package-publishing-empty"
					>
						{packageDetail.lockedAt
							? 'No unpublished commit is waiting. Publishes stay on this reviewed tree until you promote a newer commit.'
							: 'No unpublished commit is waiting. Lock publishes if you want agents to ask before going live.'}
					</p>
				) : null}
				{packageDetail.listingNeedsRepublish ? (
					<p
						css={css({ margin: 0, color: colors.textMuted })}
						data-testid="package-publishing-listing-syncing"
					>
						The community listing is catching up to this published version.
					</p>
				) : null}
			</div>
			<div
				css={css({
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.xs,
					alignItems: 'center',
				})}
			>
				<SiteLink
					href={approveHref}
					data-testid="account-approve-publish"
					css={css({
						...(needsAction
							? getPillButtonCss({ size: 'sm' })
							: {
									color: colors.textMuted,
									fontSize: typography.fontSize.sm,
									textDecoration: 'underline',
									textUnderlineOffset: '0.15em',
								}),
						display: 'inline-flex',
						textDecoration: needsAction ? 'none' : 'underline',
					})}
				>
					{primaryPublishLabel(packageDetail)}
				</SiteLink>
			</div>
			{pickerCommits.length > 0 ? (
				<details data-testid="package-release-commit-picker" css={pickerCss}>
					<summary>Choose a commit to approve</summary>
					<ol css={pickerListCss}>
						{pickerCommits.map((commit, index) => (
							<li key={commit.commit}>
								<SiteLink
									href={commitApproveHref(approveHref, commit.commit)}
									data-testid="package-release-commit-option"
									data-commit={commit.commit}
									css={pickerLinkCss}
								>
									<code>{shortCommunityCommit(commit.commit)}</code>
									<span css={pickerSubjectCss}>
										{commit.subject || '(no message)'}
									</span>
									{index === 0 ? <span css={pickerTagCss}>HEAD</span> : null}
								</SiteLink>
							</li>
						))}
					</ol>
					{packageDetail.unpublishedCommits?.truncated ? (
						<p
							css={css({
								margin: 0,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							})}
						>
							Showing the newest {pickerCommits.length}.
						</p>
					) : null}
				</details>
			) : null}
			<p
				css={css({
					margin: 0,
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
				})}
				data-testid="package-public-release-lock"
			>
				{packageDetail.lockedAt
					? 'Publish lock is on. Agents cannot publish without your approval.'
					: 'Publish lock is off. Click the lock icon above so agents cannot publish without your approval.'}
			</p>
		</section>
	)
}

const headingCss = css({
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
})

const pickerCss = css({
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	'& > summary': {
		cursor: 'pointer',
		color: colors.primaryText,
		fontSize: typography.fontSize.sm,
		fontWeight: typography.fontWeight.semibold,
	},
})

const pickerListCss = css({
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	maxHeight: '16rem',
	overflowY: 'auto',
	'& > li': { minWidth: 0 },
})

const pickerLinkCss = css({
	display: 'flex',
	alignItems: 'baseline',
	gap: spacing.sm,
	minWidth: 0,
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { borderColor: colors.primaryText },
	'& code': { color: colors.primaryText, flexShrink: 0 },
})

const pickerSubjectCss = css({
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
	flex: 1,
})

const pickerTagCss = css({
	flexShrink: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
})
