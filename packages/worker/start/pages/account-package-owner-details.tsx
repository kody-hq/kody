/** @jsxImportSource @emotion/react */
import { Badge } from '../components/badge.tsx'
import { Button } from '../components/button.tsx'
import { PackageCustomDomainsSection } from '../components/custom-domain-status.tsx'
import {
	setPackageVisibility,
	setPackageInternetVisible,
} from '#start/server/package-mutations'
import { buildPackageAppOpenPath } from '@kody-internal/shared/public-urls.ts'
import type { CSSObject } from '@emotion/react'
import { type ReactNode, useState } from 'react'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { TextLink } from '../components/text-link.tsx'
import { routes } from '#universal/routes.ts'

import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	ForkAheadLink,
	ForkOutdatedCopyButton,
} from '../components/fork-outdated-copy-button.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	getSquircleCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountDisclosureCss,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { RecordChips } from './record-table.tsx'
import { AccountPackageDeleteDialog } from './account-package-delete-dialog.tsx'
import {
	PackagePublishingPanel,
	visibilityAudienceCopy,
} from './account-package-publishing-panel.tsx'
import { AccountPackageForkAdoption } from './account-package-fork-adoption.tsx'
import { PackageCapabilityAllowanceCallout } from './package-capability-allowance-callout.tsx'
import { PackageCookieWarningsCallout } from './package-cookie-warnings-callout.tsx'
import { PackageHeldForApprovalCallout } from './package-held-for-approval-callout.tsx'
import { PackageUnmappableCredentialsCallout } from './package-unmappable-credentials-callout.tsx'
import type {
	AccountPackageAnonymousVisitorExposure,
	AccountPackageDetail,
} from '#universal/loader-data.ts'
import { Input } from '../components/input.tsx'
import { Checkbox } from '../components/choice-controls.tsx'

function PackageAppLinks(props: { openHref: string | null }) {
	if (!props.openHref) return 'No app'
	return (
		<a
			href={props.openHref}
			data-testid="open-package-app"
			css={packageAppLinkCss}
		>
			{renderIcon('share', { size: '1em' })} Open Package App
		</a>
	)
}

const packageAppLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.35rem',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	textDecoration: 'none',
	'&:hover': { color: colors.text },
} as const

function isPackageLocked(lockedAt: string | null | undefined) {
	return typeof lockedAt === 'string' && lockedAt.trim().length > 0
}

export function AccountPackageOwnerDetails(props: {
	ownerUsername: string
	packageDetail: AccountPackageDetail
	lockInFlight: boolean
	viewerCanPublish: boolean
	viewerCanDelete: boolean
	viewerCanAdoptCommunityFork: boolean
	onToggleLock: () => void
	/**
	 * Server-built Open app href. Omitted in unit renders, which fall back to
	 * the path mount. Null means the package has no app link.
	 */
	packageAppHref?: string | null
	/** Credits panel, shown under the overview. */
	usage?: ReactNode
	/** Webhooks panel, shown after publishing and before the fork and delete panels. */
	webhooks?: ReactNode
}) {
	const visibilityMutation = usePackageMutation(
		props.packageDetail.id,
		setPackageVisibility,
		'set-visibility',
	)
	const internetMutation = usePackageMutation(
		props.packageDetail.id,
		setPackageInternetVisible,
		'set-internet-visible',
	)
	const capture = useSubmitterScope()
	const [confirmName, setConfirmName] = useState('')
	const visibilityPending =
		visibilityMutation.pendingAction === 'set-visibility'
	const [visibilityMessage, setVisibilityMessage] = useState<string | null>(
		null,
	)
	const collaboratorsHref = routes.communityPackageCollaborators.href({
		username: props.ownerUsername,
		kodyId: props.packageDetail.kodyId,
	})

	async function submitVisibility(
		packageDetail: AccountPackageDetail,
		visibility: 'public' | 'private',
	) {
		if (visibilityPending) return
		if (confirmName.trim() !== packageDetail.kodyId) {
			setVisibilityMessage(
				visibility === 'public'
					? `Type ${packageDetail.kodyId} to make this package forkable. Anyone will be able to read and fork the default branch on /community.`
					: `Type ${packageDetail.kodyId} to turn off forkable. Public URLs will 404; existing forks keep their copies.`,
			)

			return
		}
		setVisibilityMessage(null)

		const isCurrent = capture()
		try {
			await visibilityMutation.submit({
				packageId: props.packageDetail.id,
				visibility,
				confirmName: confirmName.trim(),
			})
			if (!isCurrent()) return
			setConfirmName('')
		} catch (error) {
			if (!isCurrent()) return
			setVisibilityMessage(
				error instanceof Error
					? error.message
					: 'Could not update package visibility.',
			)
		}
	}

	const [internetVisibleConfirmName, setInternetVisibleConfirmName] =
		useState('')
	const [internetVisibleMessage, setInternetVisibleMessage] = useState<
		string | null
	>(null)
	const [internetVisibleApprovalUrl, setInternetVisibleApprovalUrl] = useState<
		string | null
	>(null)
	const [ownerDataConfirmed, setOwnerDataConfirmed] = useState(false)
	const ownerDataWarning = props.packageDetail.isInternetVisible
		? null
		: ownerDataWarningFor(props.packageDetail.anonymousVisitorExposure)
	const internetVisibleState = internetMutation.isPending
		? 'submitting'
		: 'idle'
	async function submitInternetVisible(
		packageDetail: AccountPackageDetail,
		internetVisible: boolean,
	) {
		if (visibilityMutation.isPending || internetMutation.isPending) return
		setInternetVisibleApprovalUrl(null)
		if (internetVisibleConfirmName.trim() !== packageDetail.kodyId) {
			setInternetVisibleMessage(
				internetVisible
					? `Type ${packageDetail.kodyId} to continue. You will review credentials before the app is served publicly.`
					: `Type ${packageDetail.kodyId} to turn off internet-visible serving.`,
			)
			return
		}
		if (internetVisible && ownerDataWarning && !ownerDataConfirmed) {
			setInternetVisibleMessage(
				'Confirm that anyone with the URL could use what this app runs as before continuing.',
			)
			return
		}
		const isCurrent = capture()
		setInternetVisibleMessage(null)
		try {
			await internetMutation.submit({
				packageId: props.packageDetail.id,
				internetVisible,
				confirmName: internetVisibleConfirmName.trim(),
			})
			if (!isCurrent()) return
			setInternetVisibleConfirmName('')
			setOwnerDataConfirmed(false)
		} catch (error) {
			if (!isCurrent()) return
			setInternetVisibleMessage(
				error instanceof Error
					? error.message
					: 'Could not update internet-visible setting.',
			)
			if (
				error instanceof Error &&
				'approvalUrl' in error &&
				typeof error.approvalUrl === 'string'
			)
				setInternetVisibleApprovalUrl(error.approvalUrl)
		}
	}

	const { packageDetail, lockInFlight, onToggleLock } = props
	const locked = isPackageLocked(packageDetail.lockedAt)
	return (
		<>
			<PackageUnmappableCredentialsCallout
				notice={packageDetail.unmappableCredentialsNotice}
				collaboratorsHref={collaboratorsHref}
			/>
			{props.viewerCanPublish ? (
				<PackageHeldForApprovalCallout
					held={packageDetail.heldForApproval}
					approvalHref={routes.communityPackageApproveCapabilities.href({
						username: props.ownerUsername,
						kodyId: packageDetail.kodyId,
					})}
				/>
			) : null}
			{props.viewerCanPublish ? (
				<PackageCapabilityAllowanceCallout
					capabilities={packageDetail.capabilityAllowance ?? []}
				/>
			) : null}
			{props.viewerCanPublish ? (
				<PackageCookieWarningsCallout
					warnings={packageDetail.cookieWarnings ?? []}
				/>
			) : null}
			<AccountManagementPanel
				headingId="package-owner-details-title"
				testId="package-owner-details"
				title="Overview"
				actions={
					<>
						{packageDetail.listingAhead ? (
							<ForkOutdatedCopyButton
								prompt={packageDetail.listingAhead.prompt}
								testId="account-package-listing-ahead"
								href={packageDetail.listingAhead.diffHref}
							/>
						) : packageDetail.forkAhead ? (
							<ForkAheadLink
								href={packageDetail.forkAhead.diffHref}
								testId="account-package-listing-fork-ahead"
							/>
						) : null}
						<button
							type="button"
							disabled={lockInFlight}
							title={locked ? 'Unlock publishes' : 'Lock publishes'}
							data-testid="account-package-lock-toggle"
							data-locked={locked ? 'true' : 'false'}
							css={packageLockToggleCss}
							onClick={() => onToggleLock()}
						>
							{packageLockGlyph(locked)}
							<span css={visuallyHiddenCss}>
								{locked
									? `Unlock publishes for ${packageDetail.name}`
									: `Lock publishes for ${packageDetail.name}`}
							</span>
						</button>
					</>
				}
			>
				<div css={badgeRowCss}>
					{packageDetail.hidden ? <Badge>Hidden</Badge> : null}
					{!packageDetail.isPrivate ? (
						<Badge tone="accent">Forkable</Badge>
					) : (
						<Badge>Not forkable</Badge>
					)}
					{packageDetail.isInternetVisible ? (
						<Badge tone="accent">Internet-visible</Badge>
					) : (
						<Badge>Private app</Badge>
					)}
					<Badge>
						{packageDetail.hasCommunityListing ? 'Listed' : 'Not listed'}
					</Badge>
				</div>
				<MetadataGrid
					items={[
						{
							label: 'Kody id',
							value: <IdValue value={packageDetail.kodyId} label="Kody id" />,
						},
						{
							label: 'Package id',
							value: <IdValue value={packageDetail.id} label="package id" />,
						},
						{
							label: 'Source id',
							value: (
								<IdValue value={packageDetail.sourceId} label="source id" />
							),
						},
						{
							label: 'App',
							value: packageDetail.hasApp ? (
								<PackageAppLinks
									openHref={
										props.packageAppHref !== undefined
											? props.packageAppHref
											: buildPackageAppOpenPath({
													username: props.ownerUsername,
													kodyId: packageDetail.kodyId,
												})
									}
								/>
							) : (
								'No app'
							),
						},
						{
							label: 'Created',
							value: <TimestampValue value={packageDetail.createdAt} />,
						},
						{
							label: 'Updated',
							value: <TimestampValue value={packageDetail.updatedAt} />,
						},
						{
							label: 'Publish lock',
							value: packageDetail.lockedAt ? (
								<>
									Locked <TimestampValue value={packageDetail.lockedAt} />
								</>
							) : (
								'Off'
							),
						},
					]}
				/>
				{packageDetail.tags.length > 0 ? (
					<RecordChips items={packageDetail.tags} />
				) : null}
				{packageDetail.customDomains?.length ? (
					<PackageCustomDomainsSection
						domains={packageDetail.customDomains}
						manageHref={
							packageDetail.ownerIsPersonal
								? null
								: routes.orgSettings.href({ orgSlug: props.ownerUsername })
						}
					/>
				) : null}
				{packageDetail.searchText ? (
					<details css={accountDisclosureCss}>
						<summary>Search text</summary>
						<p css={searchTextCss}>{packageDetail.searchText}</p>
					</details>
				) : null}
			</AccountManagementPanel>
			{props.usage}
			{props.viewerCanPublish ? (
				<div css={settingsStackCss} data-testid="package-settings-sections">
					<div css={settingsStackCss} data-testid="package-visibility-controls">
						<p
							css={independentNoteCss}
							data-testid="package-settings-independent-note"
						>
							Visibility and Source sharing are separate settings. Changing one
							never changes the other.
						</p>
						<div css={independentGridCss}>
							<AccountManagementPanel
								testId="package-settings-visibility"
								headingId="package-visibility-heading"
								title="Visibility"
								description="Choose who can use the hosted app."
							>
								{renderSettingStatus(
									packageDetail.isInternetVisible
										? 'Internet-visible: anyone with the URL'
										: 'Private app: signed-in people with access',
									'package-visibility-status',
								)}
								<div
									css={settingBodyCss}
									data-testid="package-internet-visible-controls"
								>
									<p css={mutedTextCss}>
										{packageDetail.isInternetVisible
											? 'Turning off internet-visible returns the app to signed-in owner serving. Community listing stays unchanged.'
											: 'Host the app at a public URL anyone can open without signing in. Separate from community listing. Do not use this for apps that show private data.'}
									</p>
									{packageDetail.hasApp ? null : (
										<p css={mutedTextCss}>
											This package has no app yet. You can still review
											credentials after publish; serving stays inactive until an
											app exists.
										</p>
									)}
									<label css={confirmFieldCss}>
										<span css={confirmLabelCss}>
											Type <code>{packageDetail.kodyId}</code> to confirm
											<span css={visuallyHiddenCss}>
												{' '}
												the internet-visible change
											</span>
										</span>
										<Input
											value={internetVisibleConfirmName}
											placeholder={packageDetail.kodyId}
											data-testid={
												packageDetail.isInternetVisible
													? 'package-internet-visible-off-confirm'
													: 'package-internet-visible-on-confirm'
											}
											onChange={(event) => {
												if (
													!(event.currentTarget instanceof HTMLInputElement)
												) {
													return
												}
												setInternetVisibleConfirmName(event.currentTarget.value)
											}}
										/>
									</label>
									{ownerDataWarning ? (
										<PackageOwnerDataWarning
											exposure={ownerDataWarning}
											confirmed={ownerDataConfirmed}
											onConfirmedChange={setOwnerDataConfirmed}
										/>
									) : null}
									<div css={settingActionsCss}>
										<Button
											type="button"
											disabled={
												internetVisibleState === 'submitting' ||
												(ownerDataWarning != null && !ownerDataConfirmed)
											}
											data-testid={
												packageDetail.isInternetVisible
													? 'package-internet-visible-off'
													: 'package-internet-visible-on'
											}
											variant="secondary"
											onClick={() =>
												void submitInternetVisible(
													packageDetail,
													!packageDetail.isInternetVisible,
												)
											}
										>
											{internetVisibleState === 'submitting'
												? 'Saving…'
												: packageDetail.isInternetVisible
													? 'Turn off internet-visible'
													: 'Make internet-visible'}
										</Button>
										<Button
											href={routes.communityPackageApproveCapabilities.href({
												username: props.ownerUsername,
												kodyId: packageDetail.kodyId,
											})}
											data-testid="package-approve-capabilities-link"
											variant="ghost"
										>
											Review credentials
										</Button>
									</div>
									{internetVisibleMessage ? (
										<p css={errorTextCss} role="alert">
											{internetVisibleMessage}
											{internetVisibleApprovalUrl ? (
												<>
													{' '}
													<TextLink
														tone="prose"
														href={internetVisibleApprovalUrl}
													>
														Open approval page
													</TextLink>
												</>
											) : null}
										</p>
									) : null}
								</div>
							</AccountManagementPanel>
							<AccountManagementPanel
								testId="package-settings-source-sharing"
								headingId="package-source-sharing-heading"
								title="Source sharing"
								description="Choose who can read and fork the source."
							>
								{renderSettingStatus(
									visibilityAudienceCopy(packageDetail),
									'package-source-sharing-status',
								)}
								<div css={settingBodyCss}>
									{packageDetail.isPrivate ? (
										<p
											css={mutedTextCss}
											data-testid="package-make-public-warning"
										>
											Public makes the default branch readable and forkable by
											anyone on the internet, signed in or not. To share with
											specific people, use{' '}
											<TextLink tone="prose" href={collaboratorsHref}>
												Collaborators
											</TextLink>{' '}
											instead.
										</p>
									) : (
										<p css={mutedTextCss}>
											Turn off public community listing. Public source URLs will
											404; existing forks keep their copies. Does not change
											whether the app is internet-visible.
										</p>
									)}
									<label css={confirmFieldCss}>
										<span css={confirmLabelCss}>
											Type <code>{packageDetail.kodyId}</code> to confirm
											<span css={visuallyHiddenCss}>
												{' '}
												who can see the source
											</span>
										</span>
										<Input
											value={confirmName}
											placeholder={packageDetail.kodyId}
											data-testid={
												packageDetail.isPrivate
													? 'package-make-public-confirm'
													: 'package-make-private-confirm'
											}
											css={{ minWidth: 0 }}
											onChange={(event) => {
												if (
													!(event.currentTarget instanceof HTMLInputElement)
												) {
													return
												}
												setConfirmName(event.currentTarget.value)
											}}
										/>
									</label>
									<div css={settingActionsCss}>
										<Button
											type="button"
											disabled={visibilityPending}
											data-testid={
												packageDetail.isPrivate
													? 'package-make-public'
													: 'package-make-private'
											}
											variant="secondary"
											onClick={() =>
												void submitVisibility(
													packageDetail,
													packageDetail.isPrivate ? 'public' : 'private',
												)
											}
										>
											{visibilityPending
												? 'Saving…'
												: packageDetail.isPrivate
													? 'Make public on the community'
													: 'Make private'}
										</Button>
									</div>
									{visibilityMessage ? (
										<p css={errorTextCss} role="alert">
											{visibilityMessage}
										</p>
									) : null}
								</div>
							</AccountManagementPanel>
						</div>
					</div>
					<PackagePublishingPanel
						ownerUsername={props.ownerUsername}
						packageDetail={packageDetail}
					/>
				</div>
			) : null}
			{props.webhooks}
			{props.viewerCanAdoptCommunityFork && packageDetail.communityFork ? (
				<AccountPackageForkAdoption
					packageDetail={packageDetail}
					communityFork={packageDetail.communityFork}
				/>
			) : null}
			{props.viewerCanDelete ? (
				<AccountManagementPanel
					headingId="package-delete-title"
					testId="package-delete-section"
					title="Delete package"
				>
					<AccountPackageDeleteDialog
						ownerUsername={props.ownerUsername}
						packageDetail={packageDetail}
					/>
				</AccountManagementPanel>
			) : null}
		</>
	)
}

function renderSettingStatus(status: string, testId: string) {
	return (
		<p css={settingStatusCss} data-testid={testId}>
			<span css={settingStatusLabelCss}>Now</span>
			{status}
		</p>
	)
}

function ownerDataWarningFor(
	exposure: AccountPackageAnonymousVisitorExposure | undefined,
) {
	if (!exposure) return null
	if (!exposure.known) return exposure
	return exposure.items.length > 0 ? exposure : null
}

function PackageOwnerDataWarning(props: {
	exposure: AccountPackageAnonymousVisitorExposure
	confirmed: boolean
	onConfirmedChange: (confirmed: boolean) => void
}) {
	const { exposure } = props
	return (
		<div
			css={ownerDataWarningCss}
			data-testid="package-internet-visible-owner-data-warning"
		>
			{exposure.known ? (
				<>
					<p css={{ margin: 0, fontWeight: typography.fontWeight.semibold }}>
						Anyone with the URL could use these as the person this app runs as:
					</p>
					<ul css={{ margin: 0, paddingInlineStart: '1.25rem' }}>
						{exposure.items.map((item) => (
							<li
								key={`${item.kind}:${item.name}:${item.detail ?? ''}`}
								data-testid="package-internet-visible-owner-data-item"
							>
								{item.kind === 'connector' ? 'Connector ' : ''}
								<code>{item.name}</code>
								{item.detail ? ` (${item.detail})` : null}
							</li>
						))}
					</ul>
				</>
			) : (
				<p css={{ margin: 0, fontWeight: typography.fontWeight.semibold }}>
					Kody could not check which credentials and connectors this app uses.
					Anyone with the URL could use whatever it runs as. Review credentials
					first.
				</p>
			)}
			<label css={{ display: 'flex', gap: spacing.xs, alignItems: 'start' }}>
				<Checkbox
					checked={props.confirmed}
					data-testid="package-internet-visible-owner-data-confirm"
					onChange={(event) => {
						if (!(event.currentTarget instanceof HTMLInputElement)) return
						props.onConfirmedChange(event.currentTarget.checked)
					}}
				/>
				<span>
					I understand anyone with the URL could use{' '}
					{exposure.known ? 'these' : 'them'} without signing in.
				</span>
			</label>
		</div>
	)
}

function packageLockGlyph(locked: boolean) {
	return renderIcon(locked ? 'lock' : 'lock-unlocked', { size: '1em' })
}

const packageLockToggleCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.85rem',
	height: '1.85rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	...getSquircleCss('xs'),
	backgroundColor: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	flexShrink: 0,
	'&:hover': {
		color: colors.primaryText,
		borderColor: colors.primaryText,
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'&[data-locked="true"]': {
		color: colors.primary,
		borderColor: colors.primary,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
		'&:hover': {
			color: colors.primaryText,
			borderColor: colors.primaryText,
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.2)`,
		},
	},
} satisfies CSSObject

/** Same rhythm as the tab panel, so nested groups line up with top-level cards. */
const settingsStackCss = {
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
	[mq.mobile]: { gap: spacing.md },
} satisfies CSSObject

const independentNoteCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '68ch',
} satisfies CSSObject

const independentGridCss = {
	display: 'grid',
	gap: spacing.lg,
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
	alignItems: 'stretch',
	[mq.mobile]: { gap: spacing.md },
} satisfies CSSObject

const badgeRowCss = {
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.xs,
} satisfies CSSObject

const mutedTextCss = {
	margin: 0,
	color: colors.textMuted,
} satisfies CSSObject

const errorTextCss = {
	margin: 0,
	color: colors.danger,
} satisfies CSSObject

/** Body under a setting's status: copy, confirm field, then actions. */
const settingBodyCss = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
	alignContent: 'start',
} satisfies CSSObject

const settingActionsCss = {
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
} satisfies CSSObject

const settingStatusCss = {
	margin: 0,
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'baseline',
	gap: spacing.sm,
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.borderSubtle}`,
	backgroundColor: colors.background,
	color: colors.text,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject

const settingStatusLabelCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.08em',
	textTransform: 'uppercase',
} satisfies CSSObject

const confirmFieldCss = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
} satisfies CSSObject

const confirmLabelCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	'& code': { color: colors.text },
} satisfies CSSObject

const searchTextCss = {
	margin: 0,
	maxHeight: '12rem',
	overflowY: 'auto',
	padding: spacing.sm,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
} satisfies CSSObject

const ownerDataWarningCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.sm,
	borderRadius: radius.md,
	border: `1px solid ${colors.danger}`,
	borderInlineStartWidth: '4px',
	backgroundColor: `color-mix(in srgb, ${colors.danger} 8%, ${colors.surface})`,
	color: colors.text,
	'& code': { overflowWrap: 'anywhere' },
} satisfies CSSObject
