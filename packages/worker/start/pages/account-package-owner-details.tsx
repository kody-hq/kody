/** @jsxImportSource @emotion/react */
import {
	setPackageVisibility,
	setPackageInternetVisible,
} from '#start/server/package-mutations'
import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { type CSSObject } from '@emotion/react'
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
import { PackagePublishingPanel } from './account-package-publishing-panel.tsx'
import { AccountPackageForkAdoption } from './account-package-fork-adoption.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

function PackageAppLinks(props: {
	openHref: string | null
	originHref?: string | null
}) {
	if (!props.openHref) return 'No app'
	const origin =
		props.originHref && props.originHref !== props.openHref
			? props.originHref
			: null
	let originLabel = origin
	if (origin) {
		try {
			originLabel = new URL(origin).host
		} catch {
			originLabel = origin
		}
	}
	return (
		<span
			css={{
				display: 'inline-flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				gap: '0.75rem',
			}}
		>
			<a
				href={props.openHref}
				data-testid="open-package-app"
				css={packageAppLinkCss}
			>
				{renderIcon('share', { size: '1em' })} Open Package App
			</a>
			{origin ? (
				<a
					href={origin}
					data-testid="package-app-origin-link"
					aria-label={`Open the app at ${originLabel}`}
					css={packageAppLinkCss}
				>
					{originLabel}
				</a>
			) : null}
		</span>
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
	/** Canonical hosted origin when Open app is the handoff path instead. */
	packageAppOriginHref?: string | null
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
		const isCurrent = capture()
		setInternetVisibleMessage(null)
		try {
			await internetMutation.submit({
				packageId: props.packageDetail.id,
				internetVisible,
				confirmName: internetVisibleConfirmName.trim(),
			})
			if (isCurrent()) setInternetVisibleConfirmName('')
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
			{props.viewerCanPublish ? (
				<PackagePublishingPanel
					ownerUsername={props.ownerUsername}
					packageDetail={packageDetail}
				/>
			) : null}
			{props.viewerCanPublish ? (
				<section
					css={{ display: 'grid', gap: spacing.md }}
					data-testid="package-visibility-controls"
					aria-labelledby="package-visibility-heading"
				>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h3
							id="package-visibility-heading"
							css={{
								margin: 0,
								fontSize: typography.fontSize.base,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
							}}
						>
							Visibility
						</h3>
						<p css={{ margin: 0, color: colors.textMuted }}>
							Who can open this package and whether the app is public. Type the
							slug to confirm each change.
						</p>
					</div>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<p css={{ margin: 0, color: colors.textMuted }}>
							{packageDetail.isPrivate
								? 'Make it public on the community so anyone can read and fork the source. This does not host your app.'
								: 'Turn off public community listing. Public source URLs will 404; existing forks keep their copies. Does not change whether the app is internet-visible.'}
						</p>
						<label css={{ display: 'grid', gap: spacing.xs }}>
							<span css={visuallyHiddenCss}>
								Type {packageDetail.kodyId} to change who can see the source
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
								}}
								onChange={(event) => {
									if (!(event.currentTarget instanceof HTMLInputElement)) {
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
							css={getGhostButtonCss()}
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
								This package has no app yet. You can still review credentials
								after publish; serving stays inactive until an app exists.
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
									if (!(event.currentTarget instanceof HTMLInputElement)) {
										return
									}
									setInternetVisibleConfirmName(event.currentTarget.value)
								}}
							/>
						</label>
						<div
							css={{
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.xs,
							}}
						>
							<button
								type="button"
								disabled={internetVisibleState === 'submitting'}
								data-testid={
									packageDetail.isInternetVisible
										? 'package-internet-visible-off'
										: 'package-internet-visible-on'
								}
								css={getGhostButtonCss()}
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
										: buildPackageAppPath({
												username: props.ownerUsername,
												kodyId: packageDetail.kodyId,
											})
								}
								originHref={props.packageAppOriginHref}
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
