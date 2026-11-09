/** @jsxImportSource @emotion/react */
import { PackageCustomDomainsSection } from '../components/custom-domain-status.tsx'
import {
	setPackageVisibility,
	setPackageInternetVisible,
} from '#start/server/package-mutations'
import { buildPackageAppOpenPath } from '@kody-internal/shared/public-urls.ts'
import type { CSSObject } from '@emotion/react'
import { useState } from 'react'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import { routes } from '#universal/routes.ts'

import {
	colors,
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
	getGhostButtonCss,
	getPillButtonCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	accountDisclosureCss,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { RecordChips, recordBodyCss } from './record-table.tsx'
import { AccountPackageDeleteDialog } from './account-package-delete-dialog.tsx'
import {
	PackagePublishingPanel,
	visibilityAudienceCopy,
} from './account-package-publishing-panel.tsx'
import { AccountPackageForkAdoption } from './account-package-fork-adoption.tsx'
import { PackageCapabilityAllowanceCallout } from './package-capability-allowance-callout.tsx'
import { PackageCookieWarningsCallout } from './package-cookie-warnings-callout.tsx'
import { PackageUnmappableCredentialsCallout } from './package-unmappable-credentials-callout.tsx'
import type {
	AccountPackageAnonymousVisitorExposure,
	AccountPackageDetail,
} from '#universal/loader-data.ts'

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
	return (
		<div css={recordBodyCss} data-testid="package-owner-details">
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: spacing.xs,
						flexWrap: 'wrap',
						minWidth: 0,
					}}
				>
					<h2
						css={{
							margin: 0,
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
							overflowWrap: 'anywhere',
						}}
					>
						{packageDetail.name}
					</h2>
					<button
						type="button"
						disabled={lockInFlight}
						title={
							isPackageLocked(packageDetail.lockedAt)
								? 'Unlock publishes'
								: 'Lock publishes'
						}
						data-testid="account-package-lock-toggle"
						data-locked={
							isPackageLocked(packageDetail.lockedAt) ? 'true' : 'false'
						}
						css={packageLockToggleCss}
						onClick={() => onToggleLock()}
					>
						{packageLockGlyph(isPackageLocked(packageDetail.lockedAt))}
						<span css={visuallyHiddenCss}>
							{isPackageLocked(packageDetail.lockedAt)
								? `Unlock publishes for ${packageDetail.name}`
								: `Lock publishes for ${packageDetail.name}`}
						</span>
					</button>
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
				</div>
				{packageDetail.description ? (
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							overflowWrap: 'anywhere',
						}}
					>
						{packageDetail.description}
					</p>
				) : (
					<p css={{ margin: 0, color: colors.textMuted }}>
						This package has no description.
					</p>
				)}
			</div>
			<div css={{ display: 'flex', flexWrap: 'wrap', gap: spacing.xs }}>
				{packageDetail.hidden ? <span css={statusBadgeCss}>Hidden</span> : null}
				{!packageDetail.isPrivate ? (
					<span css={communityBadgeCss}>Forkable</span>
				) : (
					<span css={statusBadgeCss}>Not forkable</span>
				)}
				{packageDetail.isInternetVisible ? (
					<span css={communityBadgeCss}>Internet-visible</span>
				) : (
					<span css={statusBadgeCss}>Private app</span>
				)}
				<span css={statusBadgeCss}>
					{packageDetail.hasCommunityListing ? 'Listed' : 'Not listed'}
				</span>
			</div>
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
			<PackageUnmappableCredentialsCallout
				notice={packageDetail.unmappableCredentialsNotice}
				collaboratorsHref={collaboratorsHref}
			/>
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
			{props.viewerCanPublish ? (
				<div css={settingsStackCss} data-testid="package-settings-sections">
					<div
						css={{ display: 'grid', gap: spacing.sm }}
						data-testid="package-visibility-controls"
					>
						<p
							css={independentNoteCss}
							data-testid="package-settings-independent-note"
						>
							Visibility and Source sharing are separate settings. Changing one
							never changes the other.
						</p>
						<div css={independentGridCss}>
							<section
								css={settingsCardCss}
								data-testid="package-settings-visibility"
								aria-labelledby="package-visibility-heading"
							>
								<SettingsSectionHeading
									id="package-visibility-heading"
									title="Visibility"
									intro="Choose who can use the hosted app."
									status={
										packageDetail.isInternetVisible
											? 'Internet-visible: anyone with the URL'
											: 'Private app: signed-in people with access'
									}
									statusTestId="package-visibility-status"
								/>
								<div
									css={{ display: 'grid', gap: spacing.xs }}
									data-testid="package-internet-visible-controls"
								>
									<p css={{ margin: 0, color: colors.textMuted }}>
										{packageDetail.isInternetVisible
											? 'Turning off internet-visible returns the app to signed-in owner serving. Community listing stays unchanged.'
											: 'Host the app at a public URL anyone can open without signing in. Separate from community listing. Do not use this for apps that show private data.'}
									</p>
									{packageDetail.hasApp ? null : (
										<p css={{ margin: 0, color: colors.textMuted }}>
											This package has no app yet. You can still review
											credentials after publish; serving stays inactive until an
											app exists.
										</p>
									)}
									<label css={{ display: 'grid', gap: spacing.xs }}>
										<span css={visuallyHiddenCss}>
											Type {packageDetail.kodyId} to change internet-visible
										</span>
										<input
											value={internetVisibleConfirmName}
											placeholder={packageDetail.kodyId}
											data-testid={
												packageDetail.isInternetVisible
													? 'package-internet-visible-off-confirm'
													: 'package-internet-visible-on-confirm'
											}
											css={{
												padding: spacing.sm,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.surface,
												color: colors.text,
											}}
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
									<div
										css={{
											display: 'flex',
											flexWrap: 'wrap',
											gap: spacing.xs,
										}}
									>
										<button
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
											css={getGhostButtonCss({ size: 'sm' })}
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
										</button>
										<SiteLink
											href={routes.communityPackageApproveCapabilities.href({
												username: props.ownerUsername,
												kodyId: packageDetail.kodyId,
											})}
											data-testid="package-approve-capabilities-link"
											css={{
												...getPillButtonCss({ size: 'sm' }),
												display: 'inline-flex',
												textDecoration: 'none',
											}}
										>
											Review credentials
										</SiteLink>
									</div>
									{internetVisibleMessage ? (
										<p css={{ margin: 0, color: colors.danger }} role="alert">
											{internetVisibleMessage}
											{internetVisibleApprovalUrl ? (
												<>
													{' '}
													<SiteLink href={internetVisibleApprovalUrl}>
														Open approval page
													</SiteLink>
												</>
											) : null}
										</p>
									) : null}
								</div>
							</section>
							<section
								css={settingsCardCss}
								data-testid="package-settings-source-sharing"
								aria-labelledby="package-source-sharing-heading"
							>
								<SettingsSectionHeading
									id="package-source-sharing-heading"
									title="Source sharing"
									intro="Choose who can read and fork the source."
									status={visibilityAudienceCopy(packageDetail)}
									statusTestId="package-source-sharing-status"
								/>
								<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
									{packageDetail.isPrivate ? (
										<p
											css={{ margin: 0, color: colors.textMuted }}
											data-testid="package-make-public-warning"
										>
											Public makes the default branch readable and forkable by
											anyone on the internet, signed in or not. To share with
											specific people, use{' '}
											<SiteLink href={collaboratorsHref}>
												Collaborators
											</SiteLink>{' '}
											instead.
										</p>
									) : (
										<p css={{ margin: 0, color: colors.textMuted }}>
											Turn off public community listing. Public source URLs will
											404; existing forks keep their copies. Does not change
											whether the app is internet-visible.
										</p>
									)}
									<label css={{ display: 'grid', gap: spacing.xs }}>
										<span css={visuallyHiddenCss}>
											Type {packageDetail.kodyId} to change who can see the
											source
										</span>
										<input
											value={confirmName}
											placeholder={packageDetail.kodyId}
											data-testid={
												packageDetail.isPrivate
													? 'package-make-public-confirm'
													: 'package-make-private-confirm'
											}
											css={{
												padding: spacing.sm,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.surface,
												color: colors.text,
												minWidth: 0,
											}}
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
									<button
										type="button"
										disabled={visibilityPending}
										data-testid={
											packageDetail.isPrivate
												? 'package-make-public'
												: 'package-make-private'
										}
										css={getGhostButtonCss({ size: 'sm' })}
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
									</button>
									{visibilityMessage ? (
										<p css={{ margin: 0, color: colors.danger }} role="alert">
											{visibilityMessage}
										</p>
									) : null}
								</div>
							</section>
						</div>
					</div>
					<PackagePublishingPanel
						ownerUsername={props.ownerUsername}
						packageDetail={packageDetail}
					/>
				</div>
			) : null}
			{packageDetail.tags.length > 0 ? (
				<RecordChips items={packageDetail.tags} />
			) : null}
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
						label: 'Source id',
						value: <IdValue value={packageDetail.sourceId} label="source id" />,
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
			{props.viewerCanAdoptCommunityFork && packageDetail.communityFork ? (
				<AccountPackageForkAdoption
					packageDetail={packageDetail}
					communityFork={packageDetail.communityFork}
				/>
			) : null}
			{props.viewerCanDelete ? (
				<AccountPackageDeleteDialog
					ownerUsername={props.ownerUsername}
					packageDetail={packageDetail}
				/>
			) : null}
			{packageDetail.searchText ? (
				<details css={accountDisclosureCss}>
					<summary>Search text</summary>
					<p
						css={{
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
						}}
					>
						{packageDetail.searchText}
					</p>
				</details>
			) : null}
		</div>
	)
}

function ownerDataWarningFor(
	exposure: AccountPackageAnonymousVisitorExposure | undefined,
) {
	if (!exposure) return null
	if (!exposure.known) return exposure
	return exposure.items.length > 0 ? exposure : null
}

function SettingsSectionHeading(props: {
	id: string
	title: string
	intro: string
	status: string
	statusTestId: string
}) {
	return (
		<div css={{ display: 'grid', gap: spacing.xs }}>
			<h3
				id={props.id}
				css={{
					margin: 0,
					fontSize: typography.fontSize.base,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				}}
			>
				{props.title}
			</h3>
			<p css={{ margin: 0, color: colors.text }}>{props.intro}</p>
			<p
				css={{
					margin: 0,
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
				}}
				data-testid={props.statusTestId}
			>
				Now: {props.status}.
			</p>
		</div>
	)
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
				<input
					type="checkbox"
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
	borderRadius: '999px',
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

const statusBadgeCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
} satisfies CSSObject

const communityBadgeCss = {
	...statusBadgeCss,
	backgroundColor: colors.primarySoft,
	border: 'none',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
} satisfies CSSObject

const settingsStackCss = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
} satisfies CSSObject

const independentNoteCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject

const independentGridCss = {
	display: 'grid',
	gap: spacing.md,
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
	alignItems: 'start',
} satisfies CSSObject

const settingsCardCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
	padding: spacing.md,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
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
