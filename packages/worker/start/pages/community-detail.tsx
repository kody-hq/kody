/** @jsxImportSource @emotion/react */
import {
	featureCommunityPackage,
	reportCommunityPackage,
} from '#start/server/community-mutations'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { type CommunityDetailApiPayload } from '../community-types.ts'
import { getPackageTreeHref } from '#universal/package-files.ts'
import {
	type CommunityDetailContentProps,
	CommunityDetailContent,
} from '../components/community-detail-content.tsx'
import { usePackageInstall } from '../use-package-install.ts'
import {
	PackageFollowProvider,
	PackageFollowPanel,
} from '../components/package-follow-panel.tsx'
import { PackageInstallContext } from '../components/package-title-actions.tsx'
import { renderMarkdownNodes } from '../components/markdown-view.tsx'
import {
	detailArticleCss,
	renderInstallStrip,
	renderReadmeSection,
	renderEmptyReadme,
	renderAdminFeatureSection as AdminFeatureSection,
	renderReportDisclosure as ReportDisclosure,
} from '../components/community-detail-sections.tsx'

export function CommunityDetailRoute({
	data,
	header,
}: {
	data: CommunityDetailApiPayload
	header: CommunityDetailContentProps
}) {
	const invalidatePages = usePageInvalidation(mutationResources)
	const invalidateReports = usePageInvalidation(reportResources)
	const capture = useSubmitterScope()
	const packageInstall = usePackageInstall(header.repoActions?.fork ?? null)
	const { installMessage, installOutcome } = packageInstall
	const [featureState, setFeatureState] = useState<
		'idle' | 'submitting' | 'error'
	>('idle')
	const [featureMessage, setFeatureMessage] = useState<string | null>(null)
	const [reportReason, setReportReason] = useState('')
	const [reportState, setReportState] = useState<
		'idle' | 'submitting' | 'success' | 'error'
	>('idle')
	const [reportMessage, setReportMessage] = useState<string | null>(null)
	const listing = data.listing
	const listingId = listing?.id
	const readme = useMemo(
		() =>
			renderMarkdownNodes(data.readmeContent ?? '', {
				headingOffset: 1,
				fences: data.readmeFences,
				imageBaseHref: data.imageBaseHref ?? undefined,
			}),
		[data.readmeContent, data.readmeFences, data.imageBaseHref],
	)
	const agentsDocsHref = data.hasAgentsDocs
		? getPackageTreeHref({
				username: data.username,
				kodyId: data.kodyId,
				listingId: listingId ?? undefined,
				relativePath: 'AGENTS.md',
			})
		: null

	// Capture reconciliation when submitted, so a later navigation cannot move
	// the write's cache work to another actor or organization. A lost response
	// still requires reconciliation because the server may have committed it.
	const lifecycle = {
		gcTime: 0,
		onMutate: () => ({ reconcile: invalidatePages }),
		onSettled: (
			_data: unknown,
			_error: Error | null,
			_variables: unknown,
			context: { reconcile: () => Promise<void> } | undefined,
		) => context?.reconcile(),
	}
	const featureMutation = useMutation({
		...lifecycle,
		mutationFn: (input: { id: string; featured: boolean }) =>
			featureCommunityPackage({
				data: { listingId: input.id, featured: input.featured },
			}).then(requireSuccess),
	})
	const reportMutation = useMutation({
		...lifecycle,
		onMutate: () => ({ reconcile: invalidateReports }),
		mutationFn: (input: { id: string; reason: string }) =>
			reportCommunityPackage({
				data: { listingId: input.id, reason: input.reason },
			}).then(requireSuccess),
	})
	async function feature() {
		if (!listing || featureMutation.isPending) return
		const isCurrent = capture()
		setFeatureState('submitting')
		setFeatureMessage(null)
		try {
			await featureMutation.mutateAsync({
				id: listing.id,
				featured: !listing.featured,
			})
			if (isCurrent()) setFeatureState('idle')
		} catch (error) {
			if (isCurrent()) {
				setFeatureState('error')
				setFeatureMessage(
					error instanceof Error
						? error.message
						: 'Unable to update featured status.',
				)
			}
		}
	}
	async function report() {
		if (!listingId || reportMutation.isPending) return
		const isCurrent = capture()
		setReportState('submitting')
		setReportMessage(null)
		try {
			await reportMutation.mutateAsync({ id: listingId, reason: reportReason })
			if (isCurrent()) {
				setReportState('success')
				setReportMessage('Report submitted. Thank you.')
				setReportReason('')
			}
		} catch (error) {
			if (isCurrent()) {
				setReportState('error')
				setReportMessage(
					error instanceof Error ? error.message : 'Unable to submit report.',
				)
			}
		}
	}
	return (
		<PackageFollowProvider
			username={data.username}
			kodyId={data.kodyId}
			follow={header.repoActions?.follow ?? null}
		>
			<PackageInstallContext.Provider value={packageInstall.context}>
				<article css={detailArticleCss}>
					<CommunityDetailContent
						{...header}
						listing={
							header.listing
								? {
										...header.listing,
										listingBehind:
											data.viewerCanManage &&
											data.ownerPackage?.listingNeedsRepublish === true,
									}
								: null
						}
					/>
					<PackageFollowPanel />
					{listingId
						? renderInstallStrip({ installMessage, installOutcome })
						: null}
					{data.readmeContent
						? renderReadmeSection(readme, agentsDocsHref)
						: renderEmptyReadme(agentsDocsHref)}
					{listingId && data.viewerIsAdmin ? (
						<AdminFeatureSection
							{...{
								featured: listing?.featured ?? false,
								featureState,
								featureMessage,
								onToggleFeature: () => void feature(),
							}}
						/>
					) : null}
					{listingId ? (
						<ReportDisclosure
							{...{
								loggedIn: data.loggedIn,
								reportReason,
								reportState,
								reportMessage,
								onReasonInput: setReportReason,
								onSubmitReport: () => void report(),
							}}
						/>
					) : null}
				</article>
			</PackageInstallContext.Provider>
		</PackageFollowProvider>
	)
}

const mutationResources = [
	'loadPackage',
	'loadPackageFiles',
	'loadCommunity',
	'loadProfile',
	'loadOnboarding',
	'loadAccountPage',
	'loadUsagePage',
] as const

const reportResources = ['loadAdminCommunityReports'] as const

function requireSuccess<T extends { ok: boolean; error?: string }>(result: T) {
	if (!result.ok)
		throw new Error(result.error ?? 'Unable to complete this action.')
	return result
}
