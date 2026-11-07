/** @jsxImportSource @emotion/react */
import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import {
	cancelPlanTransfer,
	retryPlanTransfer,
	startPlanTransfer,
} from '#start/server/billing-mutations'
import type {
	AccountBillingMovePlanLoaderData,
	PlanTransferPreview,
	PlanTransferSummary,
} from '#universal/loader-data.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import { SiteLink } from '../components/site-link.tsx'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'

type Interval = 'month' | 'year'

function formatMoney(minor: number, currency: string) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currency.toUpperCase(),
	}).format(minor / 100)
}

function formatUsdFromMicro(micro: number) {
	return formatMoney(Math.floor(micro / 10_000), 'usd')
}

function orgLabel(org: { slug: string; displayName: string | null }) {
	return org.displayName ? `${org.displayName} (@${org.slug})` : `@${org.slug}`
}

function intervalLabel(interval: Interval) {
	return interval === 'year' ? 'annual' : 'monthly'
}

function movePlanHref(
	sourceSlug: string,
	params: Record<string, string | null>,
) {
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value)
	}
	const query = search.size ? `?${search}` : ''
	return `${orgBillingPath(sourceSlug)}/move-plan${query}`
}

function newTransferId() {
	return `pt_${crypto.randomUUID().replaceAll('-', '')}`
}

export function AccountBillingMovePlanPage({
	payload,
	currentHref,
}: {
	payload: AccountBillingMovePlanLoaderData
	currentHref: string
}) {
	const sourceName = orgLabel(payload.source)
	return (
		<AccountManagementShell
			layout="form"
			currentHref={currentHref}
			maxWidth={layoutMaxWidths.content}
			busy={false}
		>
			<AccountPageHeader
				entity="billing"
				title="Move your plan"
				description={`Move the Pro plan paid for in ${sourceName} to another organization you own. The unused part of what you prepaid becomes a credit there. Nothing else moves.`}
				currentHref={currentHref}
			/>
			{payload.notice ? (
				<AccountManagementMessage tone="info">
					{payload.notice}
				</AccountManagementMessage>
			) : null}
			{payload.transfer ? (
				<TransferStatusPanel
					sourceSlug={payload.source.slug}
					transfer={payload.transfer}
				/>
			) : null}
			{!payload.transfer || payload.transfer.status === 'canceled' ? (
				<>
					<TargetPicker payload={payload} />
					{payload.blocked ? (
						<AccountManagementPanel title="This plan cannot move yet">
							<AccountManagementMessage tone="error">
								{payload.blocked.message}
							</AccountManagementMessage>
						</AccountManagementPanel>
					) : null}
					{payload.preview ? (
						<PreviewPanel
							sourceSlug={payload.source.slug}
							preview={payload.preview}
						/>
					) : null}
				</>
			) : null}
			<p css={descriptionCss}>
				<SiteLink href={orgBillingPath(payload.source.slug)} css={mutedLinkCss}>
					Back to billing
				</SiteLink>
			</p>
		</AccountManagementShell>
	)
}

function TargetPicker({
	payload,
}: {
	payload: AccountBillingMovePlanLoaderData
}) {
	if (payload.targets.length === 0) {
		return (
			<AccountManagementPanel
				title="Choose where the plan goes"
				description="You can only move a plan to another organization you own. Create one, or ask an owner of an existing organization to make you an owner."
			>
				<SiteLink href="/account/organizations" css={mutedLinkCss}>
					Manage organizations
				</SiteLink>
			</AccountManagementPanel>
		)
	}
	return (
		<AccountManagementPanel
			title="Choose where the plan goes"
			description="Organizations you own. Billing admins and members cannot receive a moved plan."
		>
			<ul css={optionListCss} aria-label="Organizations you own">
				{payload.targets.map((target) => {
					const selected = target.slug === payload.selectedTargetSlug
					return (
						<li key={target.slug}>
							<SiteLink
								href={movePlanHref(payload.source.slug, {
									to: target.slug,
									interval: payload.interval,
								})}
								aria-current={selected ? 'true' : undefined}
								css={optionCss(selected)}
							>
								<span css={{ fontWeight: typography.fontWeight.semibold }}>
									{orgLabel(target)}
								</span>
								<span css={{ color: colors.textMuted }}>
									{target.paid ? 'Paid plan' : 'Free'}
									{target.personal ? ' · Personal' : ''}
								</span>
							</SiteLink>
						</li>
					)
				})}
			</ul>
		</AccountManagementPanel>
	)
}

function PreviewPanel({
	sourceSlug,
	preview,
}: {
	sourceSlug: string
	preview: PlanTransferPreview
}) {
	const router = useRouter()
	const [acknowledged, setAcknowledged] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const transferIdRef = useRef(newTransferId())
	const { source, target, credit } = preview
	const sourceName = orgLabel(source)
	const targetName = orgLabel(target)
	const currency = credit.currency
	const mutation = useMutation({
		retry: false,
		gcTime: 0,
		mutationFn: () =>
			startPlanTransfer({
				data: {
					orgSlug: sourceSlug,
					targetSlug: target.slug,
					interval: target.interval,
					transferId: transferIdRef.current,
				},
			}),
	})
	async function confirm() {
		setError(null)
		try {
			const result = await mutation.mutateAsync()
			if (result.checkoutUrl) {
				window.location.assign(result.checkoutUrl)
				return
			}
			await router.navigate({
				href: movePlanHref(sourceSlug, { transfer: result.transferId }),
			})
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: 'The plan did not move. Try again shortly.',
			)
		}
	}
	const pending = mutation.isPending || mutation.isSuccess
	const creditText = formatMoney(credit.amountMinor, currency)
	return (
		<AccountManagementPanel
			title="Review the move"
			description="Nothing changes until you confirm. Amounts come from Stripe and are before tax."
		>
			<section aria-label="Cost" css={blockCss}>
				<h3 css={blockTitleCss}>Cost for {targetName}</h3>
				{target.mode === 'checkout' ? (
					<>
						<p css={paragraphCss}>
							{targetName} starts Pro {intervalLabel(target.interval)} at Stripe
							Checkout: {formatMoney(target.pricePerSeatMinor, currency)} per
							seat per {target.interval}, {target.seats}{' '}
							{target.seats === 1 ? 'seat' : 'seats'}, so{' '}
							<strong>
								{formatMoney(target.dueTodayMinor, currency)} today
							</strong>
							. After that, {creditText} of credit from {sourceName} is applied
							to its next invoices.
						</p>
						<IntervalSwitch
							sourceSlug={sourceSlug}
							targetSlug={target.slug}
							current={target.interval}
						/>
					</>
				) : (
					<p css={paragraphCss}>
						{targetName} already pays for Pro {intervalLabel(target.interval)} (
						{target.seats} {target.seats === 1 ? 'seat' : 'seats'},{' '}
						{formatMoney(target.recurringMinor, currency)} per {target.interval}
						). Nothing is charged today. {creditText} of credit is applied to
						its next invoices.
					</p>
				)}
			</section>
			<MetadataGrid
				items={[
					{
						label: 'Remaining prepaid value',
						value: `${creditText} from ${source.interval === 'year' ? 'the annual' : 'the monthly'} plan`,
					},
					{
						label: `Seats in @${target.slug}`,
						value: `${target.seats} (every owner and member)`,
					},
					{
						label: `Seats in @${source.slug} now`,
						value: String(source.seats),
					},
					{
						label: 'Current period ends',
						value: source.periodEndAt
							? formatTimestampDate(source.periodEndAt)
							: 'Unknown',
					},
				]}
			/>
			<section aria-label="Access" css={blockCss}>
				<h3 css={blockTitleCss}>Access</h3>
				<p css={paragraphCss}>
					Everyone in {targetName} gets Pro limits once the move finishes.
					Members of {sourceName} keep their access to it, on Free limits.
					Nobody is added to or removed from either organization.
				</p>
			</section>
			<section aria-label={`What happens to @${source.slug}`} css={blockCss}>
				<h3 css={blockTitleCss}>What happens to {sourceName}</h3>
				<ul css={listCss}>
					<li>
						Its Pro subscription is canceled now and it switches to Free. You
						are not charged again for it.
					</li>
					<li>
						All of its data stays: packages, jobs, credentials, connections,
						memories, inboxes, and storage. Nothing is deleted or moved. If it
						is over a Free limit, existing items keep working, but you cannot
						add more of that kind until it is under the limit.
					</li>
					<li>
						Credentials and connections stay in {sourceName}. Kody never copies
						or moves them; reconnect them in {targetName} yourself if you need
						them there.
					</li>
					{source.walletBalanceMicroUsd > 0 ? (
						<li>
							Its {formatUsdFromMicro(source.walletBalanceMicroUsd)} of usage
							credits stays with it and is usable again if it returns to Pro.
						</li>
					) : null}
					<li>
						You will own {preview.freeOrgsAfter.owned} of the{' '}
						{preview.freeOrgsAfter.max} Free organizations a person can own.
					</li>
				</ul>
				<p css={paragraphCss}>Free limits for {sourceName}:</p>
				<MetadataGrid
					items={preview.freeLimits.map((limit) => ({
						label: limit.label,
						value: limit.value,
					}))}
				/>
			</section>
			<label css={checkboxRowCss}>
				<input
					type="checkbox"
					checked={acknowledged}
					onChange={(event) => setAcknowledged(event.currentTarget.checked)}
				/>
				<span>
					I understand {sourceName} switches to Free now and its unused Pro
					value becomes a credit for {targetName}.
				</span>
			</label>
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			<div>
				<button
					type="button"
					disabled={!acknowledged || pending}
					onClick={() => void confirm()}
					css={getPillButtonCss({ size: 'sm' })}
				>
					{pending
						? 'Moving plan…'
						: target.mode === 'checkout'
							? `Continue to checkout for @${target.slug}`
							: `Move Pro to @${target.slug}`}
				</button>
			</div>
		</AccountManagementPanel>
	)
}

function IntervalSwitch({
	sourceSlug,
	targetSlug,
	current,
}: {
	sourceSlug: string
	targetSlug: string
	current: Interval
}) {
	const other: Interval = current === 'year' ? 'month' : 'year'
	return (
		<p css={paragraphCss}>
			<SiteLink
				href={movePlanHref(sourceSlug, { to: targetSlug, interval: other })}
				css={mutedLinkCss}
			>
				Bill @{targetSlug} {intervalLabel(other)} instead
			</SiteLink>
		</p>
	)
}

function TransferStatusPanel({
	sourceSlug,
	transfer,
}: {
	sourceSlug: string
	transfer: PlanTransferSummary
}) {
	const router = useRouter()
	const [error, setError] = useState<string | null>(null)
	const retry = useMutation({
		retry: false,
		gcTime: 0,
		mutationFn: () =>
			retryPlanTransfer({
				data: { orgSlug: sourceSlug, transferId: transfer.id },
			}),
	})
	const cancel = useMutation({
		retry: false,
		gcTime: 0,
		mutationFn: () =>
			cancelPlanTransfer({
				data: { orgSlug: sourceSlug, transferId: transfer.id },
			}),
	})
	async function run(action: typeof retry | typeof cancel) {
		setError(null)
		try {
			await action.mutateAsync()
			await router.invalidate()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Try again shortly.')
		}
	}
	const target = transfer.targetSlug
		? `@${transfer.targetSlug}`
		: 'the other organization'
	const source = transfer.sourceSlug
		? `@${transfer.sourceSlug}`
		: 'the other organization'
	const credit =
		transfer.creditAmountMinor != null && transfer.currency
			? formatMoney(transfer.creditAmountMinor, transfer.currency)
			: null
	if (transfer.status === 'completed') {
		return (
			<AccountManagementPanel title="Plan moved">
				<p role="status" css={successCss}>
					Pro now lives in {target}. {source} is on Free with all of its data in
					place.
					{credit
						? ` ${credit} of unused value was credited to ${target}.`
						: ''}
				</p>
				<SiteLink
					href={orgBillingPath(transfer.targetSlug ?? sourceSlug)}
					css={mutedLinkCss}
				>
					Open billing for {target}
				</SiteLink>
			</AccountManagementPanel>
		)
	}
	if (transfer.status === 'canceled') {
		return (
			<AccountManagementPanel title="Move canceled">
				<AccountManagementMessage tone="info">
					{transfer.errorMessage ??
						'This move was canceled. Your plan did not change.'}
				</AccountManagementMessage>
			</AccountManagementPanel>
		)
	}
	return (
		<AccountManagementPanel
			title="Plan move in progress"
			description={
				transfer.status === 'pending_checkout'
					? `Waiting for checkout for ${target} to finish. ${source} keeps Pro until it does.`
					: `Moving Pro from ${source} to ${target}. Each step is saved, so a retry continues where it stopped.`
			}
		>
			{transfer.errorMessage ? (
				<AccountManagementMessage tone="error">
					{transfer.errorMessage}
				</AccountManagementMessage>
			) : null}
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
				<button
					type="button"
					disabled={retry.isPending}
					onClick={() => void run(retry)}
					css={getPillButtonCss({ size: 'sm' })}
				>
					{retry.isPending ? 'Retrying…' : 'Retry now'}
				</button>
				{transfer.cancelable ? (
					<button
						type="button"
						disabled={cancel.isPending}
						onClick={() => void run(cancel)}
						css={getGhostButtonCss({ size: 'sm' })}
					>
						Cancel move
					</button>
				) : null}
			</div>
		</AccountManagementPanel>
	)
}

const optionListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

function optionCss(selected: boolean) {
	return {
		display: 'flex',
		justifyContent: 'space-between',
		gap: spacing.md,
		flexWrap: 'wrap' as const,
		padding: spacing.md,
		borderRadius: radius.md,
		border: `1px solid ${selected ? colors.primary : colors.border}`,
		background: selected ? colors.primarySoft : colors.surface,
		color: colors.text,
		textDecoration: 'none',
	}
}

const blockCss = { display: 'grid', gap: spacing.sm }
const blockTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}
const paragraphCss = { margin: 0, color: colors.text }
const listCss = {
	margin: 0,
	paddingLeft: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}
const checkboxRowCss = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	color: colors.text,
}
const successCss = { margin: 0, color: colors.text }
