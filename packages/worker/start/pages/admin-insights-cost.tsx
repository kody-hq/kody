/** @jsxImportSource @emotion/react */

import { SiteLink } from '../components/site-link.tsx'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	costVsPayFootnote,
	formatDynamicWorkerUsd,
} from '#universal/dynamic-worker-cost.ts'
import {
	type AdminCostRiskKind,
	type AdminInsightsDynamicWorkerCost,
	type AdminInsightsDynamicWorkerCostConsumer,
} from '#universal/loader-data.ts'
import {
	adminUserDetailHref,
	formatAdminCostRiskLabel,
	formatUsdFromCents,
} from '#client/routes/admin-insights-shared.ts'
import {
	ChartCard,
	TableScroller,
	tableHeadCellCss,
	tableNumericCellCss,
	tableStickyColumnCss,
} from './admin-insights-sections.tsx'

const riskBucketOrder = [
	'paid_underwater',
	'free_near_allotment',
	'missing_price_id',
] as const satisfies ReadonlyArray<Exclude<AdminCostRiskKind, 'none'>>

const riskBucketCopy: Record<
	(typeof riskBucketOrder)[number],
	{ title: string; emptyText: string }
> = {
	paid_underwater: {
		title: 'Paid underwater',
		emptyText: 'No catalog-paid accounts are over list MRR this month.',
	},
	free_near_allotment: {
		title: 'Unpaid near included allotment',
		emptyText:
			'No unpaid accounts are at ≥$1 / 500 unique days (50% of the $2 included-bucket alert).',
	},
	missing_price_id: {
		title: 'Paid unknown / missing price id',
		emptyText:
			'No Standard/Pro stripe_plan rows are missing a catalog price id.',
	},
}

function riskInk(risk: AdminCostRiskKind) {
	switch (risk) {
		case 'paid_underwater':
			return colors.danger
		case 'free_near_allotment':
			return colors.warningText
		case 'missing_price_id':
			return colors.textMuted
		case 'none':
			return colors.textMuted
		default: {
			const exhaustive: never = risk
			throw new Error(`Unknown cost risk: ${String(exhaustive)}`)
		}
	}
}

function formatMarginUsd(amount: number) {
	const formatted = formatDynamicWorkerUsd(Math.abs(amount))
	if (amount > 0) return `+${formatted}`
	if (amount < 0) return `−${formatted}`
	return formatted
}

function renderRiskBadge(row: AdminInsightsDynamicWorkerCostConsumer) {
	const label = formatAdminCostRiskLabel(row.risk, row.estimatedGrossUsd)
	if (!label) return null
	return (
		<span
			css={{
				display: 'inline-block',
				marginLeft: spacing.xs,
				color: riskInk(row.risk),
				fontSize: typography.fontSize.xs,
			}}
		>
			{label}
		</span>
	)
}

function renderCostVsPayTable(input: {
	ariaLabel: string
	emptyText: string
	rows: Array<AdminInsightsDynamicWorkerCostConsumer>
}) {
	if (input.rows.length === 0) {
		return <p css={{ margin: 0, color: colors.textMuted }}>{input.emptyText}</p>
	}
	return (
		<TableScroller>
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
						<th
							scope="col"
							css={{ ...tableHeadCellCss, ...tableStickyColumnCss }}
						>
							User
						</th>
						<th scope="col" css={{ ...tableHeadCellCss, textAlign: 'right' }}>
							Est. cost
						</th>
						<th scope="col" css={{ ...tableHeadCellCss, textAlign: 'right' }}>
							Paid
						</th>
						<th scope="col" css={{ ...tableHeadCellCss, textAlign: 'right' }}>
							Margin
						</th>
					</tr>
				</thead>
				<tbody>
					{input.rows.map((row) => (
						<tr key={row.stableUserId}>
							<td
								css={{
									...tableStickyColumnCss,
									padding: `${spacing.xs} ${spacing.sm}`,
									// Long usernames wrap inside a bounded column instead
									// of pushing every number off a phone screen.
									minWidth: '7rem',
									maxWidth: '12rem',
									overflowWrap: 'anywhere',
								}}
							>
								<SiteLink
									href={adminUserDetailHref(row.stableUserId)}
									css={{ color: colors.text, textDecoration: 'none' }}
								>
									{row.username}
								</SiteLink>
								{renderRiskBadge(row)}
							</td>
							<td css={tableNumericCellCss}>
								{formatDynamicWorkerUsd(row.estimatedGrossUsd)}
								<span css={{ color: colors.textMuted }}>
									{' '}
									({formatIntegerNumber(row.uniqueWorkerDays)})
								</span>
							</td>
							<td css={{ ...tableNumericCellCss, color: colors.textMuted }}>
								{formatUsdFromCents(row.estimatedPaidUsdCents)}
							</td>
							<td
								css={{
									...tableNumericCellCss,
									color:
										row.risk === 'paid_underwater'
											? colors.danger
											: colors.textMuted,
								}}
							>
								{formatMarginUsd(row.estimatedMarginUsd)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</TableScroller>
	)
}

function renderRiskBuckets(
	consumers: Array<AdminInsightsDynamicWorkerCostConsumer>,
) {
	const hasRisk = consumers.some((row) => row.risk !== 'none')
	if (!hasRisk) {
		return (
			<p css={{ margin: 0, color: colors.textMuted }}>
				No scanned users are past a cost-risk threshold this month.
			</p>
		)
	}
	return (
		<div css={{ display: 'grid', gap: spacing.md }}>
			{riskBucketOrder.map((bucket) => {
				const rows = consumers.filter((row) => row.risk === bucket)
				return (
					<div key={bucket} css={{ display: 'grid', gap: spacing.xs }}>
						<h4
							css={{
								margin: 0,
								fontSize: typography.fontSize.sm,
								fontWeight: typography.fontWeight.semibold,
								color: riskInk(bucket),
							}}
						>
							{riskBucketCopy[bucket].title}
						</h4>
						{renderCostVsPayTable({
							ariaLabel: riskBucketCopy[bucket].title,
							emptyText: riskBucketCopy[bucket].emptyText,
							rows,
						})}
					</div>
				)
			})}
		</div>
	)
}

export function renderCostVsPay(cost: AdminInsightsDynamicWorkerCost) {
	return (
		<ChartCard
			title="Cost vs pay"
			sub={`${costVsPayFootnote} Highest unique-worker-day users this month, then risk ranked within each bucket.`}
			span={12}
		>
			<div
				css={{
					display: 'grid',
					gap: spacing.lg,
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					alignItems: 'start',
					[mq.tablet]: {
						gridTemplateColumns: 'minmax(0, 1fr)',
					},
				}}
			>
				<div css={{ display: 'grid', gap: spacing.sm }}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.base,
						}}
					>
						Highest estimated cost
					</h3>
					{renderCostVsPayTable({
						ariaLabel: 'Highest estimated Dynamic Worker cost vs list pay',
						emptyText: 'No unique Dynamic Worker days recorded this month yet.',
						rows: cost.topConsumers,
					})}
				</div>
				<div css={{ display: 'grid', gap: spacing.sm }}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.base,
						}}
					>
						Risk
					</h3>
					{renderRiskBuckets(cost.riskConsumers)}
				</div>
			</div>
		</ChartCard>
	)
}
