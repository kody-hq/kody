/** @jsxImportSource @emotion/react */
import { approvePackagePublish } from '#start/server/package-mutations'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildHumanApprovalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { type CSSObject } from '@emotion/react'
import { useState, useRef, useEffect, type ReactNode } from 'react'
import { shortCommunityCommit } from '#universal/community-display.ts'
import { useRouter } from '@tanstack/react-router'

import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	type AccountPackageListingBehindHint,
	type AccountPackageApprovePublishLoaderData,
} from '#universal/loader-data.ts'
function approvePublishDetailItems(
	payload: AccountPackageApprovePublishLoaderData,
) {
	const items: Array<{ label: string; value: ReactNode }> = []
	// Title already names the short public commit when nothing is pending,
	// do not repeat it in the metadata grid.
	if (payload.alreadyPublished || !payload.pendingCommit) {
		return items
	}
	items.push(
		{
			label: 'Current published commit',
			value: payload.publishedCommit ? (
				<IdValue value={payload.publishedCommit} label="published commit" />
			) : (
				'None'
			),
		},
		{
			label: payload.package.lockedAt ? 'Commit to promote' : 'HEAD to publish',
			value: <IdValue value={payload.pendingCommit} label="pending commit" />,
		},
	)
	return items
}

function renderListingBehindPrompt(input: {
	listing?: AccountPackageListingBehindHint | null
}) {
	if (!input.listing?.behind) return null
	return (
		<div
			data-testid="approve-publish-listing-syncing"
			css={{
				display: 'grid',
				gap: spacing.xs,
				padding: spacing.sm,
				borderRadius: '0.55rem',
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.surface,
			}}
		>
			<p css={{ margin: 0, color: colors.text }}>
				The community listing is catching up to this published version. No extra
				republish step is required.
			</p>
		</div>
	)
}

export function AccountPackageApprovePublishRoute({
	payload,
}: {
	payload: AccountPackageApprovePublishLoaderData
	username: string
	kodyId: string
}) {
	const mutation = usePackageMutation(
		payload.package.id,
		approvePackagePublish,
		'approve-publish',
	)
	const capture = useSubmitterScope()
	const router = useRouter(),
		currentHref = useMatchedPageScope().pageLocation.href
	const [busy, setBusy] = useState(false),
		[message, setMessage] = useState<string | null>(null)
	const [promotedListing, setPromotedListing] =
		useState<AccountPackageListingBehindHint | null>(null)
	const busyRef = useRef(false),
		mounted = useRef(false)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	async function promoteCommit() {
		if (!payload.pendingCommit || busyRef.current) return
		await submit(
			{
				packageId: payload.package.id,
				commit: payload.pendingCommit,
			},
			payload.packageHref,
		)
	}
	async function submit(
		body: Parameters<typeof approvePackagePublish>[0]['data'],
		destination: string,
	) {
		if (busyRef.current) return
		busyRef.current = true
		setBusy(true)
		setMessage(null)
		const isCurrent = capture()
		try {
			const accepted = await mutation.submit(body)
			if (isCurrent()) {
				if (accepted.listing?.behind) setPromotedListing(accepted.listing)
				else await router.navigate({ to: destination })
			}
		} catch (error) {
			if (isCurrent())
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to approve these changes.',
				)
		} finally {
			busyRef.current = false
			if (mounted.current) setBusy(false)
		}
	}
	const nothingToPublish =
		payload != null && (payload.alreadyPublished || !payload.pendingCommit)
	const upToDateShort =
		payload?.alreadyPublished && payload.publishedCommit
			? shortCommunityCommit(payload.publishedCommit)
			: null
	const headUpToDate =
		Boolean(payload?.alreadyPublished) &&
		Boolean(payload?.pendingIsDefaultHead) &&
		upToDateShort != null
	const pinnedCommitAlreadyPublished =
		Boolean(payload?.alreadyPublished) &&
		payload?.pendingIsDefaultHead === false &&
		upToDateShort != null
	const detailItems = approvePublishDetailItems(payload)
	return (
		<AccountManagementShell currentHref={currentHref} busy={busy}>
			<AccountPageHeader
				title={
					promotedListing
						? 'Published'
						: headUpToDate
							? `Nothing to publish: the public version is up to date at ${upToDateShort}`
							: pinnedCommitAlreadyPublished
								? `This commit is already published at ${upToDateShort}`
								: nothingToPublish
									? 'Nothing to publish'
									: payload?.package.lockedAt
										? 'Approve package publish'
										: 'Publish HEAD'
				}
				description={
					promotedListing
						? 'This version is live. The community listing follows automatically when the package is public.'
						: headUpToDate
							? 'No unpublished commit is waiting. Nothing was approved or changed.'
							: pinnedCommitAlreadyPublished
								? 'The commit in this link matches the live version. Open Approve without a commit pin to review default-branch HEAD if it has moved.'
								: nothingToPublish
									? 'No commit is available to publish from this page.'
									: payload?.package.lockedAt
										? 'Review the files that changed since the last publish, then promote this commit. The package stays locked.'
										: 'Review the files that changed since the last publish, then publish default-branch HEAD. Runtime keeps using the published commit until you do.'
				}
				currentHref={currentHref}
			/>
			{message ? (
				<>
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
					<ErrorAgentPromptButton
						prompt={buildHumanApprovalErrorAgentPrompt({
							activity:
								'Approving a package publish from the browser approval page.',
							errorMessage: message,
							ids: {
								packageName: payload?.package.name,
								packageKodyId: payload?.package.kodyId,
								path: currentHref,
							},
						})}
					/>
				</>
			) : null}

			{promotedListing ? (
				<section
					data-testid="package-approve-publish-success"
					css={getAccentCalloutCss()}
				>
					<p>
						{payload.package.name} is published at{' '}
						<code>{shortCommunityCommit(payload.pendingCommit ?? '')}</code>.
					</p>
					{renderListingBehindPrompt({ listing: promotedListing })}
					<SiteLink
						href={payload.packageHref}
						css={getPillButtonCss({ size: 'sm' })}
					>
						Back to package
					</SiteLink>
				</section>
			) : null}
			{payload && !promotedListing ? (
				<section
					data-testid="package-approve-publish-card"
					css={getAccentCalloutCss()}
				>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h2
							css={{
								margin: 0,
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
							}}
						>
							{payload.package.name}
						</h2>
						<p css={{ margin: 0, color: colors.textMuted }}>
							{payload.package.lockedAt
								? 'This package is locked. Promoting a commit does not unlock it.'
								: 'This package is not locked. Lock it from the package page if you want later publishes to require approval.'}
						</p>
					</div>
					{renderListingBehindPrompt({ listing: payload.listing })}
					{payload.secretMountCompatNotice ? (
						<p
							data-testid="secret-mount-compat-notice"
							css={{
								margin: 0,
								color: colors.text,
								padding: spacing.sm,
								borderRadius: '0.55rem',
								border: `1px solid ${colors.warning}`,
							}}
						>
							{payload.secretMountCompatNotice}
						</p>
					) : null}
					{payload.allowedPackagesPublishNotice ? (
						<p
							data-testid="allowed-packages-publish-notice"
							css={{
								margin: 0,
								color: colors.text,
								padding: spacing.sm,
								borderRadius: '0.55rem',
								border: `1px solid ${colors.warning}`,
								whiteSpace: 'pre-wrap',
							}}
						>
							{payload.allowedPackagesPublishNotice}
						</p>
					) : null}
					{nothingToPublish && headUpToDate ? (
						<p
							data-testid="approve-publish-empty-state"
							css={{ margin: 0, color: colors.textMuted }}
						>
							You are all caught up. Come back here when HEAD moves, or when an
							agent asks you to approve a locked publish.
						</p>
					) : null}
					{detailItems.length > 0 ? (
						<details
							data-testid="package-approve-publish-details"
							css={accountDisclosureCss}
						>
							<summary>Details</summary>
							<MetadataGrid items={detailItems} />
						</details>
					) : null}
					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.xs,
						}}
					>
						{payload.alreadyPublished || !payload.pendingCommit ? (
							<SiteLink
								href={payload.packageHref}
								css={{
									...getPillButtonCss({ size: 'sm' }),
									display: 'inline-flex',
									textDecoration: 'none',
								}}
							>
								Back to package
							</SiteLink>
						) : (
							<>
								<button
									type="button"
									data-testid="approve-package-publish"
									disabled={busy}
									css={getPillButtonCss({ size: 'sm' })}
									onClick={() => void promoteCommit()}
								>
									{busy
										? payload.package.lockedAt
											? 'Promoting…'
											: 'Publishing…'
										: payload.package.lockedAt
											? 'Promote this commit'
											: 'Publish HEAD'}
								</button>
								<SiteLink
									href={payload.packageHref}
									css={{
										...getGhostButtonCss({ size: 'sm' }),
										display: 'inline-flex',
										textDecoration: 'none',
									}}
								>
									Cancel
								</SiteLink>
							</>
						)}
						<SiteLink
							href={payload.filesHref}
							css={{
								...getGhostButtonCss({ size: 'sm' }),
								display: 'inline-flex',
								textDecoration: 'none',
							}}
						>
							Browse published files
						</SiteLink>
					</div>
					<section
						data-testid="package-publish-diff"
						css={{ display: 'grid', gap: spacing.sm }}
					>
						<h3
							css={{
								margin: 0,
								fontSize: typography.fontSize.base,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
							}}
						>
							{payload.alreadyPublished
								? 'No unpublished changes'
								: payload.diff.files.length === 0
									? 'Could not load a file diff for these commits'
									: `${payload.diff.files.length} file${payload.diff.files.length === 1 ? '' : 's'} changed`}
						</h3>
						{payload.diff.omittedCount > 0 ? (
							<p css={{ margin: 0, color: colors.textMuted }}>
								{payload.diff.omittedCount} more file
								{payload.diff.omittedCount === 1 ? '' : 's'} omitted.
							</p>
						) : null}
						{payload.diff.files.map((file) => (
							<details
								key={file.path}
								data-testid="package-publish-diff-file"
								data-status={file.status}
								css={diffFileCss}
							>
								<summary css={diffSummaryCss}>
									<span css={diffStatusCss}>{file.status}</span>
									<code>{file.path}</code>
								</summary>
								{file.patch ? (
									<pre css={diffPatchCss}>{file.patch}</pre>
								) : (
									<p css={{ margin: 0, color: colors.textMuted }}>
										Preview unavailable for this file.
									</p>
								)}
							</details>
						))}
					</section>
				</section>
			) : null}
		</AccountManagementShell>
	)
}

const diffFileCss: CSSObject = {
	margin: 0,
	borderRadius: '0.55rem',
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const diffSummaryCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	padding: `${spacing.xs} ${spacing.sm}`,
	cursor: 'pointer',
	color: colors.text,
	'& code': {
		font: `500 0.85rem/1.3 ${typography.fontFamilyMono}`,
	},
}

const diffStatusCss: CSSObject = {
	flexShrink: 0,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
	color: colors.textMuted,
}

const diffPatchCss: CSSObject = {
	margin: 0,
	padding: spacing.sm,
	overflowX: 'auto' as const,
	borderTop: `1px solid ${colors.border}`,
	font: `400 0.78rem/1.45 ${typography.fontFamilyMono}`,
	whiteSpace: 'pre-wrap' as const,
	color: colors.text,
}
