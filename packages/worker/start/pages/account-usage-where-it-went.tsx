/** @jsxImportSource @emotion/react */
import { whereItWentSectionId } from '#universal/org-pages.ts'
import { SiteLink } from '../components/site-link.tsx'
import { useState } from 'react'
import { AreaChart } from '../charts/area-chart.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { AccountManagementPanel } from './account-management-components.tsx'
import {
	creditAttributionDefaultVisiblePackages,
	type CreditAttributionBreakdown,
	type CreditAttributionRow,
} from '#universal/credit-attribution.ts'
import { formatOnCreditsMicroUsd } from '#universal/usage-presentation.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

/**
 * "Where it went" on `/account/usage`: ranked packages + Ad hoc for this
 * period's past-include credits. Details expand closed by default. No chart
 * in the default view; no UWD jargon.
 */

function formatShare(share: number) {
	if (!Number.isFinite(share) || share <= 0) return '0%'
	const percent = Math.round(share * 1000) / 10
	return `${percent}%`
}

function formatDayLabel(day: string) {
	const date = new Date(`${day}T00:00:00.000Z`)
	if (Number.isNaN(date.getTime())) return day
	return date.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	})
}

function renderMeterSplit(row: CreditAttributionRow) {
	if (row.meters.length === 0) {
		return <p css={descriptionCss}>No billable Worker compute or Rows read.</p>
	}
	return (
		<p css={descriptionCss} data-where-it-went-split>
			{row.meters
				.map(
					(meter) =>
						`${meter.label}: ${formatOnCreditsMicroUsd(meter.creditsMicroUsd)}`,
				)
				.join(' · ')}
		</p>
	)
}

function renderCumulativeGraph(input: {
	id: string
	row: CreditAttributionRow
	ariaLabel: string
}) {
	if (input.row.cumulative.length === 0) return null
	return (
		<div data-where-it-went-graph={input.row.packageId || 'adhoc'}>
			<AreaChart
				id={input.id}
				ariaLabel={input.ariaLabel}
				xLabels={input.row.cumulative.map((point) => formatDayLabel(point.day))}
				series={[
					{
						label: 'Credits',
						color: chartColor.blue,
						values: input.row.cumulative.map(
							(point) => point.creditsMicroUsd / 1_000_000,
						),
					},
				]}
				height={180}
			/>
		</div>
	)
}

export function WhereItWentPanel({
	breakdown,
}: {
	breakdown: CreditAttributionBreakdown
}) {
	const [showAll, setShowAll] = useState(false)
	const packageRows = breakdown.rows.filter((row) => !row.isAdHoc)
	const adHocRow = breakdown.rows.find((row) => row.isAdHoc) ?? null
	const visiblePackages = showAll
		? packageRows
		: packageRows.slice(0, creditAttributionDefaultVisiblePackages)
	const hiddenCount = packageRows.length - visiblePackages.length
	const rows = [...visiblePackages, ...(adHocRow ? [adHocRow] : [])]
	return (
		<AccountManagementPanel
			id={whereItWentSectionId}
			title="Where it went"
			description={
				breakdown.totalCreditsMicroUsd > 0
					? `Credits past this month's include, by package. Total ${formatOnCreditsMicroUsd(breakdown.totalCreditsMicroUsd)}.`
					: "Credits past this month's include, by package. Nothing on credits yet."
			}
		>
			{rows.length === 0 ? (
				<p css={descriptionCss}>No past-include credits this period.</p>
			) : (
				<ul data-where-it-went css={listCss}>
					{rows.map((row) => (
						<li
							key={row.isAdHoc ? 'adhoc' : row.packageId}
							data-where-it-went-row={row.isAdHoc ? 'adhoc' : row.packageId}
							css={rowCss}
						>
							<details css={detailsCss}>
								<summary css={summaryCss}>
									<span css={nameCss}>{row.name}</span>
									<span css={metaCss}>
										<span data-where-it-went-credits>
											{formatOnCreditsMicroUsd(row.creditsMicroUsd)}
										</span>
										<span data-where-it-went-share>
											{formatShare(row.share)}
										</span>
									</span>
								</summary>
								<div css={expandCss}>
									{row.isAdHoc ? (
										<>
											<p css={descriptionCss}>
												Direct execute and any debit we cannot tie to a package.
											</p>
											{renderCumulativeGraph({
												id: `where-adhoc-${breakdown.month}`,
												row,
												ariaLabel:
													'Cumulative Ad hoc credits across the period',
											})}
										</>
									) : (
										<>
											{renderMeterSplit(row)}
											{row.href ? (
												<p css={{ margin: 0 }}>
													<SiteLink href={row.href} css={primaryLinkCss}>
														Open package
													</SiteLink>
												</p>
											) : null}
										</>
									)}
								</div>
							</details>
						</li>
					))}
				</ul>
			)}
			{hiddenCount > 0 ? (
				<button
					type="button"
					data-where-it-went-show-all
					onClick={() => setShowAll(true)}
					css={showAllCss}
				>
					Show all ({formatIntegerNumber(packageRows.length)} packages)
				</button>
			) : null}
		</AccountManagementPanel>
	)
}

/** Package page: period credit total, meter split, cumulative graph. */
export function PackageCreditAttributionPanel({
	row,
}: {
	row: CreditAttributionRow
}) {
	return (
		<AccountManagementPanel
			title="Credits this period"
			description="Past-include credits for this package this UTC month."
		>
			<p
				data-package-credits-total
				css={{
					margin: 0,
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				{formatOnCreditsMicroUsd(row.creditsMicroUsd)}
			</p>
			{renderMeterSplit(row)}
			{renderCumulativeGraph({
				id: `package-credits-${row.packageId}`,
				row,
				ariaLabel: `Cumulative credits for ${row.name} across the period`,
			})}
		</AccountManagementPanel>
	)
}

const listCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}

const rowCss = {
	borderTop: `1px solid ${colors.border}`,
	paddingTop: spacing.sm,
	'&:first-of-type': { borderTop: 'none', paddingTop: 0 },
}

const detailsCss = {
	margin: 0,
}

const summaryCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'space-between',
	alignItems: 'baseline',
	gap: spacing.sm,
	cursor: 'pointer',
	listStyle: 'none',
	'&::-webkit-details-marker': { display: 'none' },
}

const nameCss = {
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const metaCss = {
	display: 'inline-flex',
	gap: spacing.md,
	fontVariantNumeric: 'tabular-nums' as const,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const expandCss = {
	display: 'grid',
	gap: spacing.sm,
	paddingTop: spacing.sm,
	paddingBottom: spacing.xs,
}

const showAllCss = {
	marginTop: spacing.sm,
	padding: `${spacing.xs} ${spacing.md}`,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.surface,
	color: colors.text,
	cursor: 'pointer',
	fontSize: typography.fontSize.sm,
}
