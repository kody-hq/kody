/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { css } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { shortCommunityCommit } from '#universal/community-display.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

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

function visibilityAudienceCopy(packageDetail: AccountPackageDetail) {
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

/**
 * One publishing panel for package settings: what is live, what is newer, and
 * a single primary publish/promote action (plus lock / empty states).
 */
export function PackagePublishingPanel(input: {
	ownerUsername: string
	packageDetail: AccountPackageDetail
}): ReactNode {
	const { packageDetail, ownerUsername } = input
	const liveVersion = liveVersionLabel(packageDetail)
	const newer = newerChangesCopy(packageDetail)
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

	return (
		<section
			data-testid="package-publishing-panel"
			css={css({
				...getAccentCalloutCss(),
				display: 'grid',
				gap: spacing.sm,
			})}
		>
			<div css={css({ display: 'grid', gap: spacing.xs })}>
				<h3
					css={css({
						margin: 0,
						fontSize: typography.fontSize.base,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					})}
				>
					Publishing
				</h3>
				<p
					css={css({ margin: 0, color: colors.text })}
					data-testid="package-publishing-live"
				>
					{liveVersion
						? `Live: ${liveVersion}. ${visibilityAudienceCopy(packageDetail)}.`
						: `Nothing published yet. ${visibilityAudienceCopy(packageDetail)}.`}
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
			<p
				css={css({
					margin: 0,
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
				})}
			>
				{packageDetail.lockedAt
					? 'This package is locked. Agents cannot publish without your approval.'
					: 'Publishes are unlocked. Click the lock icon above so agents cannot publish without your approval.'}
			</p>
		</section>
	)
}
