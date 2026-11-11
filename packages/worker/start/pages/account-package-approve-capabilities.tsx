/** @jsxImportSource @emotion/react */
import {
	approvePackageCapabilities,
	approvePackageCapabilitiesAndGoPublic,
	approvePackageCredentialNeeds,
	approvePackageWentPublic,
} from '#start/server/package-mutations'
import {
	approveCapabilitiesPageCopy,
	credentialsSectionIntro,
	credentialSummary,
	credentialVisitorsNote,
	credentialEntryKey,
	declaredFieldSummary,
	manifestFieldLabel,
	noCapabilitiesMessage,
	reachingDependency,
	selfPublishReasonText,
	storageSummary,
	unboundNeedState,
	unboundNeedSummary,
	unboundNeedsIntro,
} from '#client/routes/account-package-approve-capabilities-copy.ts'
import {
	approvalStillRunningMessage,
	capabilityApprovalLanded,
	isApprovalTimeout,
	pendingApprovalLanded,
	withApprovalTimeout,
} from '../approval-request.ts'
import { PackageSecurityAuditField } from './package-security-audit-field.tsx'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useState, type ReactNode } from 'react'
import type { CSSObject } from '@emotion/react'
import { useRouter } from '@tanstack/react-router'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountManagementHeader,
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from './account-management-components.tsx'
import type {
	AccountPackagePendingApproval,
	AccountPackageApproveCapabilitiesLoaderData,
} from '#universal/loader-data.ts'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
/**
 * Raw identifiers for the collapsed Details disclosure. The decision itself
 * reads in plain language; these are copy targets for support and agents.
 */
function approveCapabilitiesDetailItems(
	payload: AccountPackageApproveCapabilitiesLoaderData,
) {
	const items: Array<{ key: string; label: string; value: ReactNode }> = [
		{
			key: 'published-commit',
			label: 'Published commit',
			value: payload.publishedCommit ? (
				<IdValue value={payload.publishedCommit} label="published commit" />
			) : (
				'Not published'
			),
		},
		{
			key: 'fingerprint',
			label: 'Capability fingerprint',
			value: <IdValue value={payload.fingerprint} label="fingerprint" />,
		},
	]
	const listedCredentialIds = new Set<string>()
	for (const entry of payload.entries) {
		if (entry.kind === 'credential' && entry.credentialId) {
			if (listedCredentialIds.has(entry.credentialId)) continue
			listedCredentialIds.add(entry.credentialId)
			const name = entry.name ?? 'Credential'
			items.push({
				key: `credential:${entry.credentialId}`,
				label: `${name} credential ID`,
				value: (
					<IdValue value={entry.credentialId} label={`${name} credential ID`} />
				),
			})
		} else if (entry.kind === 'storage' && entry.storageId) {
			const dependency = reachingDependency(entry)
			const label = dependency
				? `Package storage ID (${dependency})`
				: 'Package storage ID'
			items.push({
				key: `storage:${entry.storageId}`,
				label,
				value: <IdValue value={entry.storageId} label={label} />,
			})
		}
	}
	return items
}

const approveCapabilitiesRouteId =
	'/_app/@{$username}_/$kodyId_/approve-capabilities'

export function AccountPackageApproveCapabilitiesRoute({
	payload,
}: {
	payload: AccountPackageApproveCapabilitiesLoaderData
	username: string
	kodyId: string
}) {
	const capabilities = usePackageMutation(
		payload.package.id,
		withApprovalTimeout(approvePackageCapabilities),
		'approve-capabilities',
	)
	const goPublic = usePackageMutation(
		payload.package.id,
		withApprovalTimeout(approvePackageCapabilitiesAndGoPublic),
		'approve-capabilities-and-go-public',
	)
	const credentials = usePackageMutation(
		payload.package.id,
		withApprovalTimeout(approvePackageCredentialNeeds),
		'approve-credential-needs',
	)
	const wentPublic = usePackageMutation(
		payload.package.id,
		withApprovalTimeout(approvePackageWentPublic),
		'approve-went-public',
	)
	const capture = useSubmitterScope()
	const router = useRouter()
	const currentHref = useMatchedPageScope().pageLocation.href
	const [approvingRequestId, setApprovingRequestId] = useState<string | null>(
		null,
	)
	const [approvingCapabilities, setApprovingCapabilities] = useState(false)
	const busy =
		capabilities.pendingAction !== undefined ||
		approvingRequestId !== null ||
		approvingCapabilities
	const goPublicRequestId = payload.goPublicRequestId ?? null
	const allPendingApprovals = payload.pendingApprovals ?? []
	const pendingApprovals = goPublicRequestId
		? allPendingApprovals.filter(
				(approval) => approval.id !== goPublicRequestId,
			)
		: allPendingApprovals
	const pageCopy = approveCapabilitiesPageCopy(payload)
	const hasWentPublicPending = pendingApprovals.some(
		(approval) => approval.reason === 'went_public',
	)
	const hasCredentialNeedsPending = pendingApprovals.some(
		(approval) => approval.reason === 'credential_needs_changed',
	)
	const [message, setMessage] = useState<string | null>(null)
	const credentialEntries = payload.entries.filter(
		(entry) => entry.kind === 'credential',
	)
	const storageEntries = payload.entries.filter(
		(entry) => entry.kind === 'storage',
	)
	const realtimeEntries = payload.entries.filter(
		(entry) => entry.kind === 'realtime',
	)
	const { unboundNeeds, declaredFields } = payload
	/** Fresh page data after a timed-out approve; null when it cannot load. */
	async function rereadAfterTimeout() {
		try {
			await router.invalidate({ sync: true })
		} catch {
			return null
		}
		const match = router.state.matches.find(
			(entry) => entry.routeId === approveCapabilitiesRouteId,
		)
		const data = match?.loaderData as
			| { payload?: AccountPackageApproveCapabilitiesLoaderData }
			| undefined
		return data?.payload ?? null
	}
	async function approvePending(approval: AccountPackagePendingApproval) {
		if (!approval.approveAction || busy) return
		const isCurrent = capture()
		setApprovingRequestId(approval.id)
		setMessage(null)
		try {
			const input = { packageId: payload.package.id, requestId: approval.id }
			if (approval.approveAction === 'approve-credential-needs')
				await credentials.submit(input)
			else await wentPublic.submit(input)
			if (isCurrent()) await router.invalidate({ sync: true })
		} catch (error) {
			if (!isCurrent()) return
			if (isApprovalTimeout(error)) {
				const fresh = await rereadAfterTimeout()
				if (
					isCurrent() &&
					!(fresh && pendingApprovalLanded(fresh, approval.id))
				)
					setMessage(approvalStillRunningMessage)
				return
			}
			setMessage(
				error instanceof Error
					? error.message
					: 'Could not approve this publish.',
			)
		} finally {
			if (isCurrent()) setApprovingRequestId(null)
		}
	}
	async function approveCapabilities() {
		if (!payload.publishedCommit || busy) return
		setApprovingCapabilities(true)
		const isCurrent = capture()
		setMessage(null)
		try {
			const input = {
				packageId: payload.package.id,
				fingerprint: payload.fingerprint,
			}
			if (goPublicRequestId)
				await goPublic.submit({ ...input, requestId: goPublicRequestId })
			else await capabilities.submit(input)
			if (isCurrent()) {
				if (payload.package.isInternetVisible || goPublicRequestId)
					await router.navigate({ to: payload.settingsHref })
				else await router.invalidate({ sync: true })
			}
		} catch (error) {
			if (!isCurrent()) return
			if (isApprovalTimeout(error)) {
				const fresh = await rereadAfterTimeout()
				if (!isCurrent()) return
				if (
					fresh &&
					capabilityApprovalLanded(fresh, {
						fingerprint: payload.fingerprint,
						goPublicRequestId,
					})
				) {
					if (fresh.package.isInternetVisible)
						await router.navigate({ to: payload.settingsHref })
				} else setMessage(approvalStillRunningMessage)
				return
			}
			setMessage(
				error instanceof Error
					? error.message
					: 'Could not approve capabilities.',
			)
		} finally {
			if (isCurrent()) setApprovingCapabilities(false)
		}
	}
	const restingApproveLabel = goPublicRequestId
		? 'Approve and make internet-visible'
		: payload?.package.isInternetVisible
			? 'Re-approve capability set'
			: 'Approve capability set'
	const approveActionLabel = approvingCapabilities
		? 'Approving…'
		: restingApproveLabel

	return (
		<AccountManagementShell
			layout="detail"
			currentHref={currentHref}
			busy={busy}
			maxWidth="46rem"
		>
			<AccountManagementHeader
				eyebrow={
					payload ? (
						<p
							data-testid="package-approve-capabilities-package"
							css={packageContextCss}
						>
							{payload.package.name}
						</p>
					) : null
				}
				title={pageCopy.title}
				description={pageCopy.description}
			/>
			{message ? (
				<AccountManagementMessage tone="error">
					{message}
				</AccountManagementMessage>
			) : null}

			{payload.selfPublishBlocker ? (
				<section
					data-testid="package-self-publish-blocker"
					aria-labelledby="package-self-publish-blocker-heading"
					css={{
						display: 'grid',
						gap: spacing.sm,
						padding: spacing.md,
						borderRadius: radius.md,
						background: colors.primarySoftest,
						border: `1px solid ${colors.border}`,
					}}
				>
					<h2
						id="package-self-publish-blocker-heading"
						css={{ ...heroHeadingCss, fontSize: typography.fontSize.lg }}
					>
						Why approval is required
					</h2>
					<p
						css={{ margin: 0, color: colors.textMuted }}
						data-testid="package-self-publish-blocker-message"
					>
						{payload.selfPublishBlocker.reasons.length > 0
							? 'Agents cannot make this package internet-visible without you because:'
							: payload.selfPublishBlocker.message}
					</p>
					{payload.selfPublishBlocker.reasons.length > 0 ? (
						<ul
							css={{
								margin: 0,
								paddingLeft: spacing.lg,
								color: colors.textMuted,
								display: 'grid',
								gap: spacing.xs,
							}}
							data-testid="package-self-publish-blocker-reasons"
						>
							{payload.selfPublishBlocker.reasons.map((reason, index) => (
								<li
									key={`${reason.kind}-${String(index)}`}
									data-reason-kind={reason.kind}
								>
									{selfPublishReasonText(reason, payload.package.sourceId)}
								</li>
							))}
						</ul>
					) : null}
				</section>
			) : null}

			{pendingApprovals.length > 0 ? (
				<section
					data-testid="package-pending-approvals"
					aria-labelledby="package-pending-approvals-heading"
					css={{ display: 'grid', gap: spacing.md }}
				>
					<h2 id="package-pending-approvals-heading" css={heroHeadingCss}>
						Waiting for your approval
					</h2>
					<p css={{ margin: 0, color: colors.textMuted }}>
						{hasWentPublicPending
							? 'Internet-visible serving stays off until you approve.'
							: hasCredentialNeedsPending
								? 'The previously published version keeps running until you approve.'
								: 'Nothing changes until you approve.'}
					</p>
					<ul css={cardListCss}>
						{pendingApprovals.map((approval) => (
							<li
								key={approval.id}
								data-testid="package-pending-approval"
								css={capabilityRowCss}
							>
								<strong css={cardTitleCss}>{approval.reasonLabel}</strong>
								{approval.changes.length > 0 ? (
									<ul css={{ margin: 0, color: colors.textMuted }}>
										{approval.changes.map((change) => (
											<li key={change}>{change}</li>
										))}
									</ul>
								) : null}
								<details css={accountDisclosureCss}>
									<summary>Details</summary>
									<MetadataGrid
										items={[
											{
												label:
													approval.reason === 'went_public'
														? 'Published commit'
														: 'Paused commit',
												value: (
													<IdValue
														value={approval.pendingCommit}
														label={
															approval.reason === 'went_public'
																? 'published commit'
																: 'paused commit'
														}
													/>
												),
											},
										]}
									/>
								</details>
								{approval.approveAction ? (
									<div>
										<button
											type="button"
											disabled={busy}
											data-testid="package-pending-approval-approve"
											css={getPrimaryButtonCss()}
											onClick={() => void approvePending(approval)}
										>
											{approvingRequestId === approval.id
												? 'Approving…'
												: approval.reason === 'went_public'
													? 'Approve and make internet-visible'
													: 'Approve and publish'}
										</button>
									</div>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}
			{payload ? (
				<section
					data-testid="package-approve-capabilities-card"
					aria-label="Capability set"
					css={{ display: 'grid', gap: spacing.xl }}
				>
					{!payload.publishedCommit && pageCopy.mentionInternet ? (
						<div css={getAccentCalloutCss()}>
							<p css={{ margin: 0, color: colors.textMuted }}>
								Publish this package before approving internet-visible
								capabilities.
							</p>
						</div>
					) : null}
					{payload.fingerprintMatchesApproval && !hasCredentialNeedsPending ? (
						<div css={getAccentCalloutCss()}>
							<p css={{ margin: 0, color: colors.textMuted }}>
								This capability set is already approved
								{payload.latestApprovedAt
									? ` (${payload.latestApprovedAt})`
									: ''}
								{payload.package.isInternetVisible
									? '. Approving again keeps internet-visible on for the same set.'
									: '.'}
							</p>
						</div>
					) : null}
					{!payload.publishedCommit ? null : credentialEntries.length === 0 &&
					  unboundNeeds.length === 0 &&
					  storageEntries.length === 0 &&
					  realtimeEntries.length === 0 &&
					  declaredFields.length === 0 ? (
						<section
							data-testid="package-approve-capabilities-empty"
							aria-labelledby="package-approve-capabilities-empty-heading"
							css={{ display: 'grid', gap: spacing.md }}
						>
							<h2
								id="package-approve-capabilities-empty-heading"
								css={heroHeadingCss}
							>
								Credentials and capabilities
							</h2>
							<p css={{ margin: 0, color: colors.textMuted }}>
								{noCapabilitiesMessage}
							</p>
						</section>
					) : (
						<>
							<section
								data-testid="package-approve-capabilities-credentials"
								aria-labelledby="package-approve-capabilities-credentials-heading"
								css={{ display: 'grid', gap: spacing.md }}
							>
								<h2
									id="package-approve-capabilities-credentials-heading"
									css={heroHeadingCss}
								>
									Credentials
								</h2>
								{credentialEntries.length === 0 && unboundNeeds.length === 0 ? (
									<p css={{ margin: 0, color: colors.textMuted }}>
										This package does not use any of your credentials.
									</p>
								) : null}
								{credentialEntries.length > 0 ? (
									<>
										<p css={{ margin: 0, color: colors.textMuted }}>
											{credentialsSectionIntro({
												isInternetVisible: payload.package.isInternetVisible,
												mentionInternet: pageCopy.mentionInternet,
											})}
										</p>
										<ul css={cardListCss}>
											{credentialEntries.map((entry) => {
												const visitorsNote = credentialVisitorsNote(entry)
												return (
													<li
														key={credentialEntryKey(entry)}
														data-testid="package-approve-capabilities-credential"
														css={capabilityRowCss}
													>
														<strong css={cardTitleCss}>
															{entry.name ?? 'Unnamed credential'}
														</strong>
														<span css={{ color: colors.textMuted }}>
															{credentialSummary(entry)}
														</span>
														{visitorsNote ? (
															<span
																data-testid="package-approve-capabilities-credential-visitors"
																css={{
																	color: colors.text,
																	fontWeight: typography.fontWeight.semibold,
																}}
															>
																{visitorsNote}
															</span>
														) : null}
														<span css={{ color: colors.textMuted }}>
															{entry.hosts.length > 0
																? `Can only be sent to ${entry.hosts.join(', ')}`
																: 'No hosts approved yet'}
														</span>
													</li>
												)
											})}
										</ul>
									</>
								) : null}
								{unboundNeeds.length > 0 ? (
									<>
										<p css={{ margin: 0, color: colors.textMuted }}>
											{unboundNeedsIntro(credentialEntries.length > 0)}
										</p>
										<ul css={cardListCss}>
											{unboundNeeds.map((need) => (
												<li
													key={need.needKey}
													data-testid="package-approve-capabilities-unbound-need"
													css={capabilityRowCss}
												>
													<strong css={cardTitleCss}>{need.needKey}</strong>
													<span css={{ color: colors.textMuted }}>
														{unboundNeedSummary(need)}
													</span>
													{need.description.trim() ? (
														<span css={{ color: colors.text }}>
															{need.description}
														</span>
													) : null}
													<span
														data-testid="package-approve-capabilities-unbound-need-state"
														css={{
															color: colors.text,
															fontWeight: typography.fontWeight.semibold,
														}}
													>
														{unboundNeedState(need)}
													</span>
												</li>
											))}
										</ul>
									</>
								) : null}
							</section>
							<section
								data-testid="package-approve-capabilities-other"
								aria-labelledby="package-approve-capabilities-other-heading"
								css={{ display: 'grid', gap: spacing.md }}
							>
								<h2
									id="package-approve-capabilities-other-heading"
									css={heroHeadingCss}
								>
									Other capabilities
								</h2>
								{storageEntries.length === 0 &&
								realtimeEntries.length === 0 &&
								declaredFields.length === 0 ? (
									<p css={{ margin: 0, color: colors.textMuted }}>
										No other capabilities.
									</p>
								) : (
									<ul css={cardListCss}>
										{storageEntries.map((entry) => (
											<li
												key={entry.storageId}
												data-testid="package-approve-capabilities-storage"
												css={capabilityRowCss}
											>
												<strong css={cardTitleCss}>Package storage</strong>
												<span css={{ color: colors.textMuted }}>
													{storageSummary(entry)}
												</span>
											</li>
										))}
										{realtimeEntries.map((entry) => (
											<li
												key={`realtime:${entry.anonymousRealtime ?? ''}`}
												data-testid="package-approve-capabilities-realtime"
												css={capabilityRowCss}
											>
												<strong css={cardTitleCss}>Anonymous realtime</strong>
												<span css={{ color: colors.textMuted }}>
													{entry.anonymousRealtime === 'two-way'
														? 'Visitors who are not signed in can open live connections and send messages to the app realtime code (kody.app.realtime.anonymous: "two-way").'
														: 'Visitors who are not signed in can open live connections that receive broadcasts. App code never runs for their messages (kody.app.realtime.anonymous: "receive").'}
												</span>
											</li>
										))}
										{declaredFields.map((item) => (
											<li
												key={`${item.field}:${item.via.join('/')}`}
												data-testid="package-approve-capabilities-declared-field"
												css={capabilityRowCss}
											>
												<strong css={cardTitleCss}>
													{manifestFieldLabel(item.field)}
												</strong>
												<span css={{ color: colors.textMuted }}>
													{declaredFieldSummary(item)}
												</span>
											</li>
										))}
									</ul>
								)}
							</section>
						</>
					)}
					<PackageSecurityAuditField
						audit={payload.securityAudit}
						packageName={payload.package.name}
						hasPausedPublish={allPendingApprovals.some(
							(approval) => approval.pendingCommit !== payload.publishedCommit,
						)}
					/>
					{goPublicRequestId ? (
						<p
							data-testid="package-approve-capabilities-go-public-note"
							css={{ margin: 0, color: colors.textMuted }}
						>
							{payload.fingerprintMatchesApproval
								? 'You asked to make this package internet-visible. Approving turns on internet-visible serving.'
								: 'You asked to make this package internet-visible. One approval records this capability set and turns on internet-visible serving.'}
						</p>
					) : null}
					<div css={approveActionRowCss}>
						{pageCopy.mentionInternet ? (
							<button
								type="button"
								disabled={busy || !payload.publishedCommit}
								data-testid="package-approve-capabilities"
								css={[getPrimaryButtonCss(), approveActionControlCss]}
								onClick={() => void approveCapabilities()}
							>
								{equalActionLabel(
									approveActionLabel,
									restingApproveLabel,
									backToSettingsLabel,
								)}
							</button>
						) : null}
						<SiteLink
							href={payload.settingsHref}
							css={[
								getGhostButtonCss(),
								pageCopy.mentionInternet && approveActionControlCss,
							]}
							data-testid="package-approve-capabilities-back"
						>
							{pageCopy.mentionInternet
								? equalActionLabel(
										backToSettingsLabel,
										restingApproveLabel,
										backToSettingsLabel,
									)
								: backToSettingsLabel}
						</SiteLink>
					</div>
					<details
						data-testid="package-approve-capabilities-details"
						css={accountDisclosureCss}
					>
						<summary>Details</summary>
						<MetadataGrid items={approveCapabilitiesDetailItems(payload)} />
					</details>
				</section>
			) : null}
		</AccountManagementShell>
	)
}
const packageContextCss: CSSObject = {
	margin: 0,
	width: 'fit-content',
	maxWidth: '100%',
	overflowWrap: 'anywhere' as const,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
	borderRadius: radius.full,
	padding: '0.2rem 0.7rem',
}

const heroHeadingCss: CSSObject = {
	margin: 0,
	fontSize: '1.35rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
	color: colors.text,
}

const cardListCss: CSSObject = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}

const cardTitleCss: CSSObject = {
	color: colors.text,
	fontSize: typography.fontSize.base,
	overflowWrap: 'anywhere' as const,
}

const capabilityRowCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	minWidth: 0,
}

const backToSettingsLabel = 'Back to package settings'

function equalActionLabel(visible: string, ...sizers: Array<string>) {
	return (
		<>
			<span css={approveActionFaceCss}>{visible}</span>
			{sizers.map((sizer) => (
				<span key={sizer} aria-hidden="true" css={approveActionSizerCss}>
					{sizer}
				</span>
			))}
		</>
	)
}

const approveActionRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	[mq.mobile]: {
		flexDirection: 'column' as const,
	},
}

const approveActionControlCss = {
	display: 'inline-grid',
	alignItems: 'center',
	justifyItems: 'center',
	maxWidth: '100%',
	padding: `${spacing.sm} ${spacing.md}`,
	appearance: 'none' as const,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	lineHeight: 1.25,
	whiteSpace: 'normal' as const,
	[mq.mobile]: {
		width: '100%',
	},
}

const approveActionFaceCss = {
	gridArea: '1 / 1',
}

const approveActionSizerCss = {
	gridArea: '1 / 1',
	visibility: 'hidden' as const,
}
