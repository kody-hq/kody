/** @jsxImportSource @emotion/react */
import { type QueryKey } from '@tanstack/react-query'
import { WhereItWentPanel } from './account-usage-where-it-went.tsx'
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { renderIcon } from '../components/icon.tsx'
import { adminGrantDiffersFromSubscription } from '#universal/account-plan-display.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'
import { RecordTable } from './record-table.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	hoverMq,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { warningOffersCredits } from '#universal/compute-overage.ts'
import { orgBillingPath, orgUsageCreditsPath } from '#universal/org-pages.ts'
import { formatCappedPercent } from '#universal/usage-presentation.ts'
import { creditsActionForWallet } from '#client/routes/account-usage-shared.ts'
import { AccountUsageCreditsSection } from './account-usage-credits.tsx'
import {
	renderActivityPanel,
	renderCreditsAlarm,
	renderIncludedComputePanel,
} from './account-usage-story.tsx'

const entitlementGroupOrder: Array<
	AccountUsageEntitlementConsumption['group']
> = ['monthly', 'daily', 'counts', 'storage', 'limits']

const entitlementGroupLabels: Record<
	AccountUsageEntitlementConsumption['group'],
	string
> = {
	monthly: 'Monthly compute',
	daily: 'Daily rates',
	counts: 'Resource counts',
	storage: 'Storage',
	limits: 'Per-item limits',
}

const entitlementGroupNotes: Partial<
	Record<AccountUsageEntitlementConsumption['group'], string>
> = {
	monthly: 'Included Worker compute and Rows read this UTC month.',
	daily:
		'Daily counters reset at UTC midnight. Execute and outbound fetches also have a this-week cap (UTC Monday–Sunday). High daily headroom for bursts; weekly total keeps it sustainable.',
}

function formatUsagePercent(value: number | null) {
	return formatCappedPercent(value)
}

/** Whichever window is closer to its cap — daily or weekly — is what blocks. */
export function hotterUsagePercent(
	item: Pick<AccountUsageEntitlementConsumption, 'percentOfLimit' | 'week'>,
) {
	const percents = [item.percentOfLimit, item.week?.percentOfLimit].filter(
		(value): value is number => value != null,
	)
	if (percents.length === 0) return null
	return Math.max(...percents)
}

/**
 * True when a hard daily/weekly/stock entitlement is at or over its cap.
 * Monthly compute includes (`group: 'monthly'`) are not hard caps, so they
 * never count as a hard "Limit reached."
 */
export function hasReachedEntitlementLimit(
	item: Pick<
		AccountUsageEntitlementConsumption,
		'percentOfLimit' | 'week' | 'group'
	>,
) {
	if (item.group === 'monthly') return false
	return (
		(item.percentOfLimit !== null && item.percentOfLimit >= 1) ||
		(item.week?.percentOfLimit != null && item.week.percentOfLimit >= 1)
	)
}

export function accountUsageWarningsPanelTitle(
	warnings: ReadonlyArray<
		Pick<
			AccountUsageEntitlementConsumption,
			'percentOfLimit' | 'week' | 'group'
		>
	>,
) {
	return warnings.some(hasReachedEntitlementLimit)
		? 'Limit reached'
		: 'Approaching limits'
}

export function formatEntitlementUsedPercent(
	item: Pick<AccountUsageEntitlementConsumption, 'percentOfLimit' | 'week'>,
) {
	if (item.week) {
		return `${formatUsagePercent(item.percentOfLimit)} today · ${formatUsagePercent(item.week.percentOfLimit)} this week`
	}
	return formatUsagePercent(item.percentOfLimit)
}

function formatPlanLabel(plan: AdminPlanName) {
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}

function formatBytes(value: number) {
	if (value < 1024) return `${value} B`
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
	if (value < 1024 * 1024 * 1024) {
		return `${(value / (1024 * 1024)).toFixed(1)} MiB`
	}
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function formatUsageValue(resource: string, value: number) {
	if (resource === 'storage_bytes' || resource === 'email_message_bytes') {
		return formatBytes(value)
	}
	return formatIntegerNumber(value)
}

function formatCurrentValue(item: AccountUsageEntitlementConsumption) {
	if (item.kind === 'per_unit_max') return '—'
	return formatUsageValue(item.resource, item.current)
}

function formatLimitValue(item: AccountUsageEntitlementConsumption) {
	return formatUsageValue(item.resource, item.limit)
}

function usageProgressPercent(item: AccountUsageEntitlementConsumption) {
	const percent = hotterUsagePercent(item)
	if (percent === null) return null
	return Math.min(100, Math.round(percent * 100))
}

function groupEntitlementRows(rows: Array<AccountUsageEntitlementConsumption>) {
	const grouped = new Map<
		AccountUsageEntitlementConsumption['group'],
		Array<AccountUsageEntitlementConsumption>
	>()
	for (const group of entitlementGroupOrder) grouped.set(group, [])
	for (const row of rows) {
		const bucket = grouped.get(row.group) ?? []
		bucket.push(row)
		grouped.set(row.group, bucket)
	}
	return entitlementGroupOrder
		.map((group) => ({
			group,
			rows: grouped.get(group) ?? [],
		}))
		.filter((entry) => entry.rows.length > 0)
}

type UsageResourceNameProps = {
	id: string
	label: string
	whatCounts: string
	howToReduce: string
	/** Extra sentence that used to sit under the label, such as the weekly cap note. */
	note?: string
}

/**
 * Resource label plus the long "what counts / how to reduce" copy in a
 * popover. The table stays scannable; the explanation stays one click away
 * and is not clipped by the cell's overflow.
 */
export function UsageResourceName({
	id,
	label,
	whatCounts,
	howToReduce,
	note,
}: UsageResourceNameProps) {
	const panelId = `usage-resource-${id}`
	const anchor = `--usage-resource-${id}`
	return (
		<span
			css={{
				display: 'flex',
				alignItems: 'center',
				gap: '0.35rem',
				minWidth: 0,
				width: '100%',
			}}
		>
			<span
				css={{
					fontWeight: typography.fontWeight.medium,
					color: colors.text,
					// The cell is nowrap and the table columns are fixed, so a
					// long name would paint over the info button. Shrink the
					// label and keep the button in the row.
					flex: '0 1 auto',
					minWidth: 0,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{label}
			</span>
			<button
				type="button"
				popoverTarget={panelId}
				aria-label={`What counts toward ${label}`}
				data-usage-resource-tip={id}
				css={{
					...usageTipButtonCss,
					anchorName: anchor,
				}}
			>
				{renderIcon('information', { size: '1.05rem' })}
			</button>
			<div
				id={panelId}
				popover="auto"
				role="dialog"
				aria-label={label}
				data-usage-resource-panel={id}
				css={{
					...usageTipPanelCss,
					positionAnchor: anchor,
				}}
			>
				<p css={usageTipBodyCss}>{whatCounts}</p>
				<p css={usageTipBodyCss}>{howToReduce}</p>
				{note ? <p css={usageTipBodyCss}>{note}</p> : null}
			</div>
		</span>
	)
}

const usageTipButtonCss: CSSObject = {
	display: 'inline-flex',
	flex: 'none',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.75rem',
	height: '1.75rem',
	padding: 0,
	border: 'none',
	borderRadius: radius.full,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			backgroundColor: colors.primarySoft,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const usageTipPanelCss: CSSObject = {
	// Leave `display` unset so a closed popover keeps the UA `display: none`.
	positionArea: 'bottom span-right',
	positionTryFallbacks: 'flip-block, flip-inline',
	inset: 'auto',
	width: 'min(24rem, calc(100vw - 2.5rem))',
	maxHeight: 'min(70dvh, 20rem)',
	overflow: 'auto',
	gap: '0.55rem',
	margin: '0.35rem',
	padding: '0.85rem 1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	boxSizing: 'border-box' as const,
	'&:popover-open': {
		display: 'grid',
	},
}

const usageTipBodyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.45,
	textWrap: 'pretty' as const,
}

const weeklyUsageNote =
	'High daily headroom for bursts; the weekly total keeps it sustainable.'

function renderUsageProgressBar(item: AccountUsageEntitlementConsumption) {
	const percent = usageProgressPercent(item)
	if (percent === null) return null
	const barColor = item.overEightyPercent ? chartColor.amber : chartColor.blue
	return (
		<div
			role="img"
			aria-label={`${item.label}: ${formatEntitlementUsedPercent(item)} of plan limit`}
			css={{
				height: '8px',
				borderRadius: radius.md,
				background: colors.border,
				overflow: 'hidden',
				minWidth: '4rem',
			}}
		>
			<div
				css={{
					height: '100%',
					width: `${percent}%`,
					background: barColor,
				}}
			/>
		</div>
	)
}

export function AccountUsagePage({
	queryKey,
	payload,
	currentHref,
	orgSlug,
}: {
	queryKey: QueryKey
	payload: AccountUsageLoaderData
	currentHref: string
	orgSlug: string
}) {
	const usage = payload
	const billingPath = orgBillingPath(orgSlug)
	const accountCreditsPath = orgUsageCreditsPath(orgSlug)

	const groupedRows = usage
		? groupEntitlementRows(usage.entitlementConsumption)
		: []
	const warningAction = usage
		? creditsActionForWallet(
				usage.computeOverage.creditWallet,
				usage.plan,
				usage.canBuyCredits,
				accountCreditsPath,
			)
		: null

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="usage"
				title="Usage"
				description="Activity, included compute, plan limits, and credits: what counts and how close you are."
				currentHref={currentHref}
			/>

			{usage ? (
				<>
					<AccountManagementPanel title="Plan">
						<p
							css={{
								margin: 0,
								fontSize: typography.fontSize.lg,
								fontWeight: typography.fontWeight.semibold,
								color: colors.text,
							}}
						>
							Current plan: {formatPlanLabel(usage.plan)}
						</p>
						{adminGrantDiffersFromSubscription(
							usage.manualPlan,
							usage.stripePlan,
						) ? (
							<>
								<p css={descriptionCss}>
									Your effective plan is the higher of any admin grant and your
									Stripe subscription.
								</p>
								<MetadataGrid
									items={[
										{
											label: 'Granted plan',
											value: formatPlanLabel(usage.manualPlan),
										},
										{
											label: 'Subscription plan',
											value: usage.stripePlan
												? formatPlanLabel(usage.stripePlan)
												: 'None',
										},
									]}
								/>
							</>
						) : null}
						<p css={descriptionCss}>
							Usage day (UTC): {usage.today}
							{usage.weekStart
								? ` · Week starts (UTC Monday): ${usage.weekStart}`
								: ''}
						</p>
						<p
							css={{
								margin: 0,
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.md,
							}}
						>
							<SiteLink href={billingPath} css={primaryLinkCss}>
								Manage billing
							</SiteLink>
							{usage.computeOverage.creditWallet !== 'none' ? (
								<SiteLink href={accountCreditsPath} css={primaryLinkCss}>
									Manage credits
								</SiteLink>
							) : null}
						</p>
					</AccountManagementPanel>
					{renderCreditsAlarm(usage.creditsAlarm, { showAction: true })}
					{renderActivityPanel(usage.activity, {
						note:
							usage.plan === 'free'
								? 'Free is limited by daily and weekly execute caps, listed under Daily rates.'
								: undefined,
					})}
					{renderIncludedComputePanel({
						meters: usage.includedCompute,
						summary: usage.includedComputeSummary,
					})}
					<WhereItWentPanel breakdown={usage.whereItWent} />
					{usage.warnings.length > 0 ? (
						<AccountManagementPanel
							title={accountUsageWarningsPanelTitle(usage.warnings)}
							description={
								usage.warnings.some(hasReachedEntitlementLimit)
									? 'These resources are at or over your plan limit.'
									: 'These resources are above 80% of your plan limit.'
							}
						>
							<ul
								css={{
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.sm,
									color: colors.text,
								}}
							>
								{usage.warnings.map((item) => (
									<li key={item.resource}>
										<strong>{item.label}</strong>:{' '}
										{item.week
											? `${formatCurrentValue(item)} / ${formatLimitValue(item)} today (${formatUsagePercent(item.percentOfLimit)}) · ${formatIntegerNumber(item.week.current)} / ${formatIntegerNumber(item.week.limit)} this week (${formatUsagePercent(item.week.percentOfLimit)})`
											: `${formatCurrentValue(item)} / ${formatLimitValue(item)} (${formatUsagePercent(item.percentOfLimit)})`}
										. {item.howToReduce}
										{warningAction && warningOffersCredits(item.resource) ? (
											<>
												{' '}
												<SiteLink
													href={warningAction.href}
													css={primaryLinkCss}
												>
													{warningAction.label}
												</SiteLink>
											</>
										) : null}
									</li>
								))}
							</ul>
						</AccountManagementPanel>
					) : null}
					{groupedRows.map(({ group, rows }) => (
						<AccountManagementPanel
							key={group}
							title={entitlementGroupLabels[group]}
							description={
								entitlementGroupNotes[group] ??
								'Current use compared to your plan limit.'
							}
						>
							<RecordTable
								mode="none"
								ariaLabel={`${entitlementGroupLabels[group]} usage`}
								// Each group is a handful of rows inside a panel that is
								// already part of a scrolling page; a nested scroller here
								// would only hide rows.
								scrollHeight="none"
								columns={[
									{ key: 'resource', label: 'Resource', primary: true },
									{ key: 'current', label: 'In use', align: 'end' },
									{ key: 'limit', label: 'Limit', align: 'end' },
									{ key: 'used', label: 'Used', align: 'end' },
									{ key: 'progress', label: 'Progress' },
								]}
								rows={rows.map((item) => ({
									id: item.resource,
									cells: {
										resource: (
											<UsageResourceName
												id={item.resource}
												label={item.label}
												whatCounts={item.whatCounts}
												howToReduce={item.howToReduce}
												note={item.week ? weeklyUsageNote : undefined}
											/>
										),
										current: item.week
											? `${formatCurrentValue(item)} today · ${formatIntegerNumber(item.week.current)} this week`
											: formatCurrentValue(item),
										limit: item.week
											? `${formatLimitValue(item)} / day · ${formatIntegerNumber(item.week.limit)} / week`
											: formatLimitValue(item),
										used: (
											<span
												css={
													item.overEightyPercent
														? {
																color: chartColor.amber,
																fontWeight: typography.fontWeight.semibold,
															}
														: {}
												}
											>
												{formatEntitlementUsedPercent(item)}
											</span>
										),
										progress: renderUsageProgressBar(item),
									},
								}))}
							/>
						</AccountManagementPanel>
					))}
					{usage.credits ? (
						<AccountUsageCreditsSection
							queryKey={queryKey}
							key={orgSlug}
							orgSlug={orgSlug}
							credits={usage.credits}
							notice={usage.notice}
							error={usage.error}
						/>
					) : null}
				</>
			) : null}
		</AccountManagementShell>
	)
}
