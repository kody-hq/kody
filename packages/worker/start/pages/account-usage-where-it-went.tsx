/** @jsxImportSource @emotion/react */
import { surfaceCardCss } from '#universal/styles/surface.ts'
import { whereItWentSectionId } from '#universal/org-pages.ts'
import { SiteLink } from '../components/site-link.tsx'
import { useState } from 'react'
import { AreaChart } from '../charts/area-chart.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	AccountManagementPanel,
	accountInputCss,
} from './account-management-components.tsx'
import { RecordTable } from './record-table.tsx'
import {
	creditAttributionDefaultVisiblePackages,
	filterAndSortCreditAttributionVisitors,
	type CreditAttributionAdHocConnections,
	type CreditAttributionBreakdown,
	type CreditAttributionRow,
	type CreditAttributionVisitorRow,
} from '#universal/credit-attribution.ts'
import { formatOnCreditsMicroUsd } from '#universal/usage-presentation.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
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
											{breakdown.adHocConnections &&
											breakdown.adHocConnections.rows.length > 0 ? (
												<AdHocConnectionList
													connections={breakdown.adHocConnections}
												/>
											) : null}
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
											{row.visitors ? (
												<PackageVisitorsTable
													rows={row.visitors}
													total={row.visitorCount ?? row.visitors.length}
													truncated={row.visitorsTruncated ?? false}
												/>
											) : null}
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

function AdHocConnectionList({
	connections,
}: {
	connections: CreditAttributionAdHocConnections
}) {
	return (
		<section data-where-it-went-adhoc-connections>
			<p css={descriptionCss}>
				Ad hoc workers started by each connection since{' '}
				{formatDayLabel(connections.sinceDay)} (Worker compute units, inside and
				past the include):
			</p>
			<ul css={{ margin: 0, paddingLeft: spacing.lg }}>
				{connections.rows.map((row) => (
					<li key={row.id} data-where-it-went-adhoc-connection>
						{row.label}: {formatIntegerNumber(row.workerUnits)}
					</li>
				))}
				{connections.otherWorkerUnits > 0 ? (
					<li>
						Other connections:{' '}
						{formatIntegerNumber(connections.otherWorkerUnits)}
					</li>
				) : null}
			</ul>
		</section>
	)
}

function PackageVisitorsTable({
	rows,
	total,
	truncated,
}: {
	rows: Array<CreditAttributionVisitorRow>
	total: number
	truncated: boolean
}) {
	const [search, setSearch] = useState('')
	const [sort, setSort] = useState<'credits' | 'username'>('credits')
	const [page, setPage] = useState(0)
	const pageSize = 20
	const filtered = filterAndSortCreditAttributionVisitors(rows, search, sort)
	const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
	const currentPage = Math.min(page, pageCount - 1)
	const visible = filtered.slice(
		currentPage * pageSize,
		(currentPage + 1) * pageSize,
	)
	return (
		<section data-package-visitors>
			<h3 css={{ margin: 0, fontSize: typography.fontSize.lg }}>Visitors</h3>
			<label css={{ display: 'grid', gap: spacing.xs }}>
				Search visitors
				<input
					type="search"
					value={search}
					onChange={(event) => {
						setSearch(event.currentTarget.value)
						setPage(0)
					}}
					placeholder="Search usernames"
					data-field-ring
					data-visitors-search
					css={accountInputCss}
				/>
			</label>
			<div css={{ display: 'flex', gap: spacing.sm }}>
				<button
					type="button"
					aria-pressed={sort === 'credits'}
					onClick={() => setSort('credits')}
					data-visitors-sort="credits"
					css={
						sort === 'credits'
							? getPillButtonCss({ size: 'sm' })
							: getGhostButtonCss({ size: 'sm' })
					}
				>
					Sort by credits
				</button>
				<button
					type="button"
					aria-pressed={sort === 'username'}
					onClick={() => setSort('username')}
					data-visitors-sort="username"
					css={
						sort === 'username'
							? getPillButtonCss({ size: 'sm' })
							: getGhostButtonCss({ size: 'sm' })
					}
				>
					Sort by username
				</button>
			</div>
			{rows.some((row) => row.billedToVisitorOrg) ? (
				<p css={descriptionCss} data-visitors-billed-elsewhere>
					Visitors marked "their org pays" came from another organization. Their
					org pays for the metered work their visits cause, so those units carry
					no credits here. You still pay the app's Worker compute.
				</p>
			) : null}
			<p css={descriptionCss} data-visitors-count>
				Showing {formatIntegerNumber(visible.length)} of{' '}
				{formatIntegerNumber(filtered.length)} visitors
				{truncated
					? ` (top ${formatIntegerNumber(rows.length)} of ${formatIntegerNumber(total)})`
					: ''}
			</p>
			<RecordTable
				mode="none"
				ariaLabel="Visitors"
				scrollHeight="none"
				emptyLabel="No visitors match your search."
				columns={[
					{ key: 'visitor', label: 'Visitor', primary: true },
					{ key: 'credits', label: 'Credits', align: 'end' },
					{ key: 'meters', label: 'Meters' },
					{ key: 'lastDay', label: 'Last day' },
				]}
				rows={visible.map((row, index) => ({
					id: `${row.displayName}-${row.lastDay}-${index}`,
					cells: {
						visitor: row.billedToVisitorOrg
							? `${row.displayName} (their org pays)`
							: row.displayName,
						credits: formatOnCreditsMicroUsd(row.creditsMicroUsd),
						meters: row.meters
							.map(
								(meter) =>
									`${meter.label}: ${formatIntegerNumber(meter.units)}${meter.billedToVisitorOrg ? ' (their org paid)' : ''}`,
							)
							.join(' · '),
						lastDay: row.lastDay,
					},
				}))}
			/>
			{pageCount > 1 ? (
				<div css={{ display: 'flex', gap: spacing.sm, alignItems: 'center' }}>
					<button
						type="button"
						disabled={currentPage === 0}
						onClick={() => setPage(currentPage - 1)}
						css={getGhostButtonCss({ size: 'sm' })}
					>
						Previous
					</button>
					<span>
						Page {currentPage + 1} of {pageCount}
					</span>
					<button
						type="button"
						disabled={currentPage + 1 >= pageCount}
						onClick={() => setPage(currentPage + 1)}
						css={getGhostButtonCss({ size: 'sm' })}
					>
						Next
					</button>
				</div>
			) : null}
		</section>
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
			{row.visitors ? (
				<PackageVisitorsTable
					rows={row.visitors}
					total={row.visitorCount ?? row.visitors.length}
					truncated={row.visitorsTruncated ?? false}
				/>
			) : null}
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
	...surfaceCardCss,
	color: colors.text,
	cursor: 'pointer',
	fontSize: typography.fontSize.sm,
}
