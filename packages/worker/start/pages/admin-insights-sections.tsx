/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type ReactNode } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { cardCss } from '#universal/styles/style-primitives.ts'
import {
	chartColor,
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'
import { formatDynamicWorkerUsd } from '#universal/dynamic-worker-cost.ts'
import { formatFleetPackageErrorRateConcentration } from '#universal/fleet-package-error-rate-concentration.ts'
import {
	type AdminInsightsActivation,
	type AdminInsightsActivationStep,
	type AdminInsightsDurationConsumer,
	type AdminInsightsEntitlementPressureUser,
	type AdminInsightsDynamicWorkerCost,
	type AdminInsightsEventCountConsumer,
	type AdminInsightsMetricDurationConsumers,
	type AdminInsightsPackageErrorRate,
	type AdminInsightsPackageErrorRateCounts,
	type AdminInsightsPackageErrorRateMetricRow,
} from '#universal/loader-data.ts'
import {
	adminUserDetailHref,
	formatAdminCostRiskLabel,
	formatDurationHours,
	formatPlanLabel,
	formatPressurePercent,
	runtimeDurationMetricLabels,
} from '#client/routes/admin-insights-shared.ts'

function formatAdminCostRiskSuffix(
	consumer: AdminInsightsDynamicWorkerCost['topConsumers'][number],
) {
	const label = formatAdminCostRiskLabel(
		consumer.risk,
		consumer.estimatedGrossUsd,
	)
	return label ? ` · ${label}` : ''
}

function renderConsumerTable(input: {
	ariaLabel: string
	rows: Array<{
		key: string
		username: string
		stableUserId: string
		value: string
	}>
	emptyText: string
	valueHeader: string
}) {
	if (input.rows.length === 0) {
		return <p css={{ margin: 0, color: colors.textMuted }}>{input.emptyText}</p>
	}
	return (
		<table
			aria-label={input.ariaLabel}
			css={{
				width: '100%',
				borderCollapse: 'collapse',
				fontSize: typography.fontSize.sm,
			}}
		>
			<thead>
				<tr>
					<th scope="col" css={{ ...tableHeadCellCss, textAlign: 'left' }}>
						User
					</th>
					<th scope="col" css={{ ...tableHeadCellCss, textAlign: 'right' }}>
						{input.valueHeader}
					</th>
				</tr>
			</thead>
			<tbody>
				{input.rows.map((row) => (
					<tr key={row.key}>
						<td
							css={{
								padding: `${spacing.xs} ${spacing.sm}`,
								overflowWrap: 'anywhere',
							}}
						>
							<SiteLink
								href={adminUserDetailHref(row.stableUserId)}
								css={{ color: colors.text, textDecoration: 'none' }}
							>
								{row.username}
							</SiteLink>
						</td>
						<td
							css={{
								...tableNumericCellCss,
								// Multi-part values ("$1.20 (600) · underwater") may
								// wrap at their separators on a phone.
								whiteSpace: 'normal',
								color: colors.textMuted,
							}}
						>
							{row.value}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

export function renderDurationConsumers(
	consumers: Array<AdminInsightsDurationConsumer>,
	ariaLabel: string,
) {
	return renderConsumerTable({
		ariaLabel,
		emptyText: 'No runtime duration recorded this month yet.',
		valueHeader: 'Runtime',
		rows: consumers.map((consumer) => ({
			key: consumer.stableUserId,
			username: consumer.username,
			stableUserId: consumer.stableUserId,
			value: formatDurationHours(consumer.totalDurationMs),
		})),
	})
}

export function renderDynamicWorkerCost(cost: AdminInsightsDynamicWorkerCost) {
	return (
		<div css={{ display: 'grid', gap: spacing.md }}>
			<div
				css={{
					display: 'flex',
					justifyContent: 'space-between',
					gap: spacing.sm,
					flexWrap: 'wrap',
				}}
			>
				<strong css={{ fontSize: typography.fontSize.sm }}>
					{formatDynamicWorkerUsd(cost.estimatedGrossUsd)} gross
				</strong>
				<span
					css={{
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
						fontVariantNumeric: 'tabular-nums',
					}}
				>
					{formatIntegerNumber(cost.uniqueWorkerDays)} unique worker-days
				</span>
			</div>
			{renderConsumerTable({
				ariaLabel: 'Top Dynamic Worker cost consumers this month',
				emptyText: 'No unique Dynamic Worker days recorded this month yet.',
				valueHeader: 'Gross cost',
				rows: cost.topConsumers.map((consumer) => ({
					key: consumer.stableUserId,
					username: consumer.username,
					stableUserId: consumer.stableUserId,
					value: `${formatDynamicWorkerUsd(consumer.estimatedGrossUsd)} (${formatIntegerNumber(consumer.uniqueWorkerDays)})${formatAdminCostRiskSuffix(consumer)}`,
				})),
			})}
		</div>
	)
}

export function renderEventCountConsumers(
	consumers: Array<AdminInsightsEventCountConsumer>,
) {
	return renderConsumerTable({
		ariaLabel: 'Top event count consumers this month',
		emptyText: 'No metered events recorded this month yet.',
		valueHeader: 'Events',
		rows: consumers.map((consumer) => ({
			key: consumer.stableUserId,
			username: consumer.username,
			stableUserId: consumer.stableUserId,
			value: formatIntegerNumber(consumer.eventCount),
		})),
	})
}

export function renderDurationByMetric(
	entries: Array<AdminInsightsMetricDurationConsumers>,
) {
	const hasData = entries.some((entry) => entry.consumers.length > 0)
	if (!hasData) {
		return (
			<p css={{ margin: 0, color: colors.textMuted }}>
				No per-metric runtime leaders this month yet.
			</p>
		)
	}
	return (
		<div css={{ display: 'grid', gap: spacing.md }}>
			{entries.map((entry) => (
				<div key={entry.metric} css={{ display: 'grid', gap: spacing.xs }}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.sm,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						{runtimeDurationMetricLabels[entry.metric]}
					</h3>
					{renderDurationConsumers(
						entry.consumers,
						`Top ${runtimeDurationMetricLabels[entry.metric]} duration consumers`,
					)}
				</div>
			))}
		</div>
	)
}

export function renderEntitlementPressure(
	entries: Array<AdminInsightsEntitlementPressureUser>,
) {
	if (entries.length === 0) {
		return (
			<p css={{ margin: 0, color: colors.textMuted }}>
				No accounts above 80% of a plan limit among the most active users this
				month.
			</p>
		)
	}
	return (
		<div css={{ display: 'grid', gap: spacing.md }}>
			{entries.map((entry) => (
				<div
					key={entry.stableUserId}
					css={{
						display: 'grid',
						gap: spacing.xs,
						padding: spacing.sm,
						borderRadius: '8px',
						border: `1px solid ${colors.border}`,
					}}
				>
					<div
						css={{
							display: 'flex',
							justifyContent: 'space-between',
							gap: spacing.sm,
							flexWrap: 'wrap',
						}}
					>
						<SiteLink
							href={adminUserDetailHref(entry.stableUserId)}
							css={{
								color: colors.text,
								fontWeight: typography.fontWeight.semibold,
								textDecoration: 'none',
							}}
						>
							{entry.username}
						</SiteLink>
						<span
							css={{
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							}}
						>
							{formatPlanLabel(entry.plan)} plan
						</span>
					</div>
					<ul
						css={{
							margin: 0,
							paddingLeft: spacing.lg,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						{entry.pressuredResources.map((resource) => (
							<li key={resource.resource}>
								{resource.label}: {formatIntegerNumber(resource.current)} /{' '}
								{formatIntegerNumber(resource.limit)} (
								{formatPressurePercent(resource.percentOfLimit)})
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	)
}

const packageErrorRateMetricLabels: Record<
	AdminInsightsPackageErrorRateMetricRow['metric'],
	string
> = {
	package_export: 'Package exports',
	package_static_call: 'Static package calls',
	job_run: 'Job runs',
	workflow_run: 'Workflow runs',
}

function formatErrorRate(counts: AdminInsightsPackageErrorRateCounts) {
	if (counts.rate == null) return 'n/a'
	return `${(counts.rate * 100).toFixed(1)}%`
}

function renderPackageErrorRateSummary(input: {
	label: string
	counts: AdminInsightsPackageErrorRateCounts
}) {
	return (
		<div
			css={{
				display: 'grid',
				gap: spacing.xs,
				padding: spacing.sm,
				borderRadius: '8px',
				border: `1px solid ${colors.border}`,
			}}
		>
			<span
				css={{
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
				}}
			>
				{input.label}
			</span>
			<strong
				css={{
					fontSize: typography.fontSize.xl,
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				{formatErrorRate(input.counts)}
			</strong>
			<span
				css={{
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				{formatIntegerNumber(input.counts.errors)} /{' '}
				{formatIntegerNumber(input.counts.events)}
			</span>
		</div>
	)
}

export function renderPackageErrorRate(rate: AdminInsightsPackageErrorRate) {
	if (!rate.available || !rate.day) {
		return (
			<p css={{ margin: 0, color: colors.textMuted }}>
				Fleet package error rates are unavailable until the hourly usage
				aggregation writes the Analytics Engine snapshot.
			</p>
		)
	}
	const rows = rate.day.recent.by_metric.map((recent, index) => ({
		recent,
		previous: rate.day?.previous.by_metric[index] ?? recent,
	}))
	return (
		<div css={{ display: 'grid', gap: spacing.sm }}>
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					gap: spacing.sm,
					[mq.tablet]: { gridTemplateColumns: 'minmax(0, 1fr)' },
				}}
			>
				{renderPackageErrorRateSummary({
					label: 'Last 24h',
					counts: rate.day.recent.combined,
				})}
				{renderPackageErrorRateSummary({
					label: 'Previous 24h',
					counts: rate.day.previous.combined,
				})}
				{rate.hour
					? renderPackageErrorRateSummary({
							label: 'Last hour',
							counts: rate.hour.recent.combined,
						})
					: null}
				{rate.hour
					? renderPackageErrorRateSummary({
							label: 'Previous hour',
							counts: rate.hour.previous.combined,
						})
					: null}
			</div>
			<table
				css={{
					width: '100%',
					borderCollapse: 'collapse',
					fontSize: typography.fontSize.sm,
				}}
			>
				<caption
					css={{
						captionSide: 'top',
						textAlign: 'left',
						color: colors.textMuted,
						paddingBottom: spacing.xs,
					}}
				>
					Combined rates for package_export, package_static_call, job_run, and
					workflow_run. Totals omit user ids and package UUIDs.
				</caption>
				<thead>
					<tr>
						<th
							scope="col"
							css={{
								textAlign: 'left',
								padding: spacing.xs,
								whiteSpace: 'nowrap',
							}}
						>
							Metric
						</th>
						<th
							scope="col"
							css={{
								textAlign: 'right',
								padding: spacing.xs,
								whiteSpace: 'nowrap',
							}}
						>
							Last 24h
						</th>
						<th
							scope="col"
							css={{
								textAlign: 'right',
								padding: spacing.xs,
								whiteSpace: 'nowrap',
							}}
						>
							Previous 24h
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(({ recent, previous }) => (
						<tr key={recent.metric}>
							<td css={{ padding: spacing.xs }}>
								{packageErrorRateMetricLabels[recent.metric]}
							</td>
							<td
								css={{
									textAlign: 'right',
									padding: spacing.xs,
									whiteSpace: 'nowrap',
									fontVariantNumeric: 'tabular-nums',
								}}
							>
								{formatErrorRate(recent)}
							</td>
							<td
								css={{
									textAlign: 'right',
									padding: spacing.xs,
									whiteSpace: 'nowrap',
									fontVariantNumeric: 'tabular-nums',
									color: colors.textMuted,
								}}
							>
								{formatErrorRate(previous)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{rate.concentration ? (
				<p css={{ margin: 0 }}>
					{formatFleetPackageErrorRateConcentration(rate.concentration)}
				</p>
			) : null}
			{rate.lastAlertAt ? (
				<p css={{ margin: 0, color: colors.textMuted }}>
					Last elevation alert {rate.lastAlertAt}.
				</p>
			) : null}
		</div>
	)
}

const activationStepLabels: Record<
	AdminInsightsActivationStep['step'],
	string
> = {
	signed_up: 'Signed up',
	email_verified: 'Verified email',
	agent_connected: 'Connected an agent',
	package_forked: 'Forked a package',
	package_run_succeeded: 'Package ran once',
	package_activated: 'Package ran twice',
}

export function activationSubtitle(activation: AdminInsightsActivation) {
	const activated =
		activation.steps.find((entry) => entry.step === 'package_activated')
			?.users ?? 0
	if (activated === 0) return 'Nobody has activated yet.'
	const median = activation.medianHoursToActivation
	// Activation can be recorded without usable timing — backfilled milestones
	// carry no verification date to measure from.
	if (median == null) {
		return `${formatIntegerNumber(activated)} activated; not enough timing data for a median.`
	}
	const rounded = median < 1 ? '<1' : formatIntegerNumber(Math.round(median))
	return `Median ${rounded}h from verified email to a package that ran twice.`
}

/**
 * Horizontal funnel. Bars are scaled against the first step so the drop-off
 * between stages is the thing you see; the per-row percentage is share of
 * signups, which is the number worth tracking over time.
 */
export function renderActivationFunnel(activation: AdminInsightsActivation) {
	const total = activation.steps[0]?.users ?? 0
	return (
		<div css={{ display: 'grid', gap: spacing.sm }}>
			{activation.steps.map((entry) => {
				const share = total > 0 ? entry.users / total : 0
				return (
					<div key={entry.step} css={{ display: 'grid', gap: spacing.xs }}>
						<div
							css={{
								display: 'flex',
								justifyContent: 'space-between',
								gap: spacing.sm,
								fontSize: typography.fontSize.sm,
								color: colors.text,
							}}
						>
							<span>{activationStepLabels[entry.step]}</span>
							<span
								css={{
									color: colors.textMuted,
									whiteSpace: 'nowrap',
									fontVariantNumeric: 'tabular-nums',
								}}
							>
								{formatIntegerNumber(entry.users)} · {formatPercentShare(share)}
							</span>
						</div>
						<div
							role="img"
							aria-label={`${activationStepLabels[entry.step]}: ${entry.users} users, ${formatPercentShare(share)} of signups`}
							css={{
								height: '10px',
								borderRadius: '999px',
								background: colors.border,
								overflow: 'hidden',
							}}
						>
							<div
								css={{
									height: '100%',
									width: `${Math.round(share * 100)}%`,
									background:
										entry.step === 'package_activated'
											? chartColor.emerald
											: chartColor.blue,
								}}
							/>
						</div>
					</div>
				)
			})}
		</div>
	)
}

/**
 * KPI tile row. Four across on wide screens, two on tablets, and as many
 * ~9.5rem tiles as fit on a phone so a 320px viewport stacks while a 390px+
 * one still pairs them up.
 */
export function StatGrid(props: { children: ReactNode }) {
	return (
		<div
			css={{
				display: 'grid',
				gap: spacing.md,
				gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
				[mq.tablet]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
				[mq.mobile]: {
					gap: spacing.sm,
					gridTemplateColumns: 'repeat(auto-fill, minmax(9.5rem, 1fr))',
				},
			}}
		>
			{props.children}
		</div>
	)
}

/**
 * Twelve-column card grid that `ChartCard` spans into. Every card must live
 * inside one of these: a spanning card dropped straight into the page shell
 * turns the shell's single column into twelve implicit tracks and scatters
 * its siblings across them.
 */
export function ChartGrid(props: { children: ReactNode }) {
	return (
		<div
			css={{
				display: 'grid',
				gap: spacing.lg,
				gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
				[mq.mobile]: {
					gap: spacing.md,
					gridTemplateColumns: 'minmax(0, 1fr)',
				},
			}}
		>
			{props.children}
		</div>
	)
}

/**
 * Horizontal scroll wrapper for tables that are wider than a phone. Tables
 * inside keep `width: 100%` and use `nowrap` numeric cells, so they only
 * overflow (and scroll) when the content really cannot fit.
 */
export function TableScroller(props: { children: ReactNode }) {
	return (
		<div
			css={{
				minWidth: 0,
				maxWidth: '100%',
				overflowX: 'auto',
				WebkitOverflowScrolling: 'touch',
			}}
		>
			{props.children}
		</div>
	)
}

/** Header cell styles shared by the insight tables. */
export const tableHeadCellCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	color: colors.textMuted,
	fontWeight: typography.fontWeight.medium,
	whiteSpace: 'nowrap' as const,
} satisfies CSSObject

/** Right-aligned numeric cell that never wraps mid-number. */
export const tableNumericCellCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	textAlign: 'right' as const,
	whiteSpace: 'nowrap' as const,
	fontVariantNumeric: 'tabular-nums',
} satisfies CSSObject

/**
 * Pins the first column while a `TableScroller` scrolls the numbers, so the
 * row label stays readable on a phone. Opaque background hides the cells
 * sliding underneath. A no-op when the table fits.
 */
export const tableStickyColumnCss = {
	position: 'sticky' as const,
	left: 0,
	zIndex: 1,
	backgroundColor: colors.surface,
	textAlign: 'left' as const,
} satisfies CSSObject

type ChartCardProps = {
	title: string
	sub?: string
	/** Grid column span on wide screens out of 12. */
	span?: 4 | 6 | 8 | 12
	legend?: ReactNode
	children: ReactNode
}

export function ChartCard(props: ChartCardProps) {
	const span = props.span ?? 12
	return (
		<section
			aria-label={props.title}
			css={{
				...cardCss,
				gridColumn: `span ${span}`,
				alignContent: 'start',
				minWidth: 0,
				// Tablets keep a two-up rhythm: wide cards take the row, the
				// rest pair off. Phones stack everything.
				[mq.tablet]: { gridColumn: span >= 8 ? '1 / -1' : 'span 6' },
				[mq.mobile]: {
					gridColumn: '1 / -1',
					padding: spacing.md,
					gap: spacing.sm,
				},
			}}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2
					css={{
						margin: 0,
						fontSize: typography.fontSize.base,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					}}
				>
					{props.title}
				</h2>
				{props.sub ? (
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						{props.sub}
					</p>
				) : null}
			</div>
			{props.legend ?? null}
			{props.children}
		</section>
	)
}
