/** @jsxImportSource @emotion/react */
import { lockPackage, unlockPackage } from '#start/server/package-mutations'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import { useState } from 'react'
import type { CommunityDetailApiPayload } from '../community-types.ts'
import { renderPackageRepoActions } from '../components/package-title-actions.tsx'
import {
	PackageRepoTabPanel,
	renderPackageRepoChrome,
} from '../components/package-repo-nav.tsx'
import {
	detailArticleCss,
	renderMissingListing,
} from '../components/community-detail-sections.tsx'
import {
	getPackageTreeHref,
	fallbackDefaultBranchName,
} from '#universal/package-files.ts'
import { AccountManagementMessage } from './account-management-components.tsx'
import { PackageSessionInsights } from './package-session-insights.tsx'
import { AccountPackageOwnerDetails } from './account-package-owner-details.tsx'
import { PackageCreditAttributionPanel } from './account-usage-where-it-went.tsx'
import { PackageWebhookSettings } from './package-webhook-settings.tsx'
export function PackageSettingsRoute({
	data,
}: {
	data: CommunityDetailApiPayload
}) {
	const ownerPackage = data.ownerPackage ?? null
	const capture = useSubmitterScope()
	const lock = usePackageMutation(
		ownerPackage?.id ?? '',
		lockPackage,
		'lock',
		'package',
	)
	const unlock = usePackageMutation(
		ownerPackage?.id ?? '',
		unlockPackage,
		'unlock',
		'package',
	)
	const [message, setMessage] = useState<string | null>(null)
	const username = data.username,
		kodyId = data.kodyId
	const lockBusy = lock.pendingAction !== undefined
	const optimisticLockedAt =
		lock.pendingAction === 'lock'
			? lock.pendingLockedAt
			: lock.pendingAction === 'unlock'
				? null
				: ownerPackage?.lockedAt
	async function toggleLock() {
		if (!ownerPackage || lockBusy) return
		setMessage(null)
		const isCurrent = capture()
		try {
			if (ownerPackage.lockedAt)
				await unlock.submit({ packageId: ownerPackage.id })
			else await lock.submit({ packageId: ownerPackage.id })
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Could not update the publish lock.',
			)
		}
	}
	if (!ownerPackage)
		return renderMissingListing('Not found', 'This package is not available.')
	return (
		<article css={detailArticleCss} data-testid="package-settings">
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate: ownerPackage.isPrivate,
				isListed: ownerPackage.hasCommunityListing,
				viewerIsOwner: data.viewerIsOwner,
				viewerCanManage: data.viewerCanManage,
				viewerCanManageAccess: data.viewerCanManageAccess,
				viewerCanSeeConnectedPeople: data.viewerCanSeeConnectedPeople,
				active: 'settings',
				actions: renderPackageRepoActions(data.repoActions ?? null),
				filesHref: getPackageTreeHref({
					username,
					kodyId,
					listingId: data.listing?.id ?? null,
					ref: data.listing?.defaultBranch || fallbackDefaultBranchName,
				}),
				description: ownerPackage.description ?? '',
				ownerProfilePublic: data.ownerProfilePublic,
				iconUrl: resolvePackageListIconUrl({
					username,
					kodyId,
					listingId: data.listing?.id ?? null,
					listingIconCommit: null,
					publishedCommit: ownerPackage.publishedCommit ?? null,
				}),
				iconName: kodyId,
			})}
			<PackageRepoTabPanel>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				<AccountPackageOwnerDetails
					ownerUsername={username}
					packageAppHref={data.repoActions?.packageAppHref ?? null}
					viewerCanPublish={data.viewerCanPublish === true}
					viewerCanDelete={data.viewerCanDelete === true}
					viewerCanAdoptCommunityFork={
						data.viewerCanAdoptCommunityFork === true
					}
					packageDetail={{
						...ownerPackage,
						lockedAt: optimisticLockedAt ?? null,
					}}
					lockInFlight={lockBusy}
					onToggleLock={() => void toggleLock()}
					usage={
						ownerPackage.creditAttribution ? (
							<PackageCreditAttributionPanel
								row={ownerPackage.creditAttribution}
							/>
						) : null
					}
					webhooks={
						<>
							<PackageWebhookSettings
								key={`${username}/${kodyId}`}
								username={username}
								kodyId={kodyId}
							/>
							<PackageSessionInsights
								key={`sessions:${username}/${kodyId}`}
								username={username}
								kodyId={kodyId}
							/>
						</>
					}
				/>
			</PackageRepoTabPanel>
		</article>
	)
}
