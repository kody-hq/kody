/** @jsxImportSource @emotion/react */
import {
	dashboardPanelCss,
	dashboardHeaderCss,
	dashboardHeadingCss,
	dashboardLinkCss,
} from './workspace-dashboard-styles.ts'
import { renderIcon } from '../components/icon.tsx'
import { type CSSObject } from '@emotion/react'
import {
	formatWorkspaceChartUtcDay,
	type WorkspaceBilling,
	type WorkspaceRunCharts,
	workspaceChartsPartialSince,
} from '#universal/workspace-charts.ts'
import { colors } from '#universal/styles/tokens.ts'
import { chartColor } from '#client/charts/chart-theme.ts'
import { formatOnCreditsMicroUsd } from '#universal/usage-presentation.ts'
import {
	ExecutionHistoryChart,
	WorkspaceRankingChart,
} from './workspace-chart-views.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { surfaceLabel } from './account-activity-shared.ts'

export function WorkspaceCharts({
	charts,
	billing,
	base,
}: {
	charts: WorkspaceRunCharts
	billing: WorkspaceBilling | null
	base: string
}) {
	const spend = billing?.whereItWent
	const spendRows = [...(spend?.rows ?? [])]
		.filter((row) => row.creditsMicroUsd > 0)
		.sort((a, b) => b.creditsMicroUsd - a.creditsMicroUsd)
	const series = [
		{
			label: 'Success',
			color: chartColor.emerald,
			values: charts.days.map((day) => day.success),
		},
		{
			label: 'Error',
			color: chartColor.rose,
			values: charts.days.map((day) => day.error),
		},
		{
			label: 'Running',
			color: chartColor.blue,
			values: charts.days.map((day) => day.running),
		},
	]
	const partialSince = workspaceChartsPartialSince(charts)
	const partialNote = partialSince
		? `Showing runs since ${formatWorkspaceChartUtcDay(partialSince)}.`
		: null
	return (
		<div css={gridCss}>
			<section css={panelCss} aria-labelledby="execution-history">
				<div css={headerCss}>
					<h2 id="execution-history" css={headingCss}>
						{renderIcon('chart')} Execution history
					</h2>
					<span css={mutedCss}>Last 7 days · UTC</span>
				</div>
				<div css={bodyCss}>
					<ExecutionHistoryChart days={charts.days} />
					<div css={legendCss}>
						{series.map((entry) => (
							<span key={entry.label}>
								<i
									aria-hidden="true"
									css={{
										display: 'inline-block',
										width: 8,
										height: 8,
										borderRadius: 2,
										background: entry.color,
										marginRight: 6,
									}}
								/>
								{entry.label}
							</span>
						))}
					</div>
					{partialNote ? <p css={noteCss}>{partialNote}</p> : null}
					<p css={noteCss}>Package exports and child runs excluded.</p>
				</div>
			</section>
			<section css={panelCss} aria-labelledby="activity-source">
				<div css={headerCss}>
					<h2 id="activity-source" css={headingCss}>
						{renderIcon('pie-chart')} Activity by source
					</h2>
					<span css={mutedCss}>Last 7 days</span>
				</div>
				<div css={bodyCss}>
					{charts.sources.length ? (
						<WorkspaceRankingChart
							id="workspace-sources"
							ariaLabel="Top-level execution counts by source"
							rows={charts.sources.map((source) => ({
								key: source.surface,
								label: surfaceLabel(source.surface),
								value: source.count,
								href: `${base}/activity?view=recent&status=all&triage=all&surface=${encodeURIComponent(source.surface)}`,
							}))}
						/>
					) : (
						<p css={emptyCss}>No top-level executions in this period.</p>
					)}
					{partialNote ? <p css={noteCss}>{partialNote}</p> : null}
				</div>
			</section>
			{billing && spend ? (
				<section
					css={{ ...panelCss, gridColumn: '1 / -1' }}
					aria-labelledby="credits-by-package"
				>
					<div css={headerCss}>
						<h2 id="credits-by-package" css={headingCss}>
							{renderIcon('wallet')} Credits spent by package
						</h2>
						<SiteLink css={moreCss} href={`${base}/usage`}>
							Usage & billing
						</SiteLink>
					</div>
					<div css={billingGridCss}>
						<div>
							{spendRows.length > 0 ? (
								<p css={{ ...noteCss, marginTop: 0 }}>
									{spend.month} ·{' '}
									{formatOnCreditsMicroUsd(spend.totalCreditsMicroUsd)} beyond
									included usage
								</p>
							) : null}
							{spendRows.length ? (
								<WorkspaceRankingChart
									id="workspace-credit-spend"
									currency
									ariaLabel="Credits spent beyond included usage by package in US dollars"
									rows={spendRows.slice(0, 5).map((row) => ({
										key: row.packageId || 'ad-hoc',
										label: row.name,
										value: row.creditsMicroUsd / 1_000_000,
										href: row.href ?? `${base}/usage`,
									}))}
								/>
							) : (
								<p css={emptyCss}>
									No credits spent beyond included usage this month.
								</p>
							)}
							{spendRows.length > 5 ? (
								<SiteLink css={moreCss} href={`${base}/usage`}>
									View all {spendRows.length} sources
								</SiteLink>
							) : null}
						</div>
						<div
							css={{ display: 'grid', gap: '0.6rem', alignContent: 'start' }}
						>
							{billing.includedCompute.map((meter) => (
								<div key={meter.resource}>
									<div css={labelCss}>
										<span>{meter.label}</span>
										<span>
											{meter.current.toLocaleString('en-US')}
											{!meter.informational
												? ` / ${meter.include.toLocaleString('en-US')}`
												: ''}
										</span>
									</div>
									{!meter.informational ? (
										<div
											role="meter"
											aria-label={`${meter.label}, monthly included usage`}
											aria-valuemin={0}
											aria-valuemax={Math.max(meter.include, meter.current, 1)}
											aria-valuenow={meter.current}
											aria-valuetext={`${meter.current} used, ${meter.include} included`}
											css={trackCss}
										>
											<span
												css={{
													...fillCss,
													width: `${Math.max(0, Math.min(100, meter.barPercent))}%`,
													background:
														meter.tone === 'attention'
															? chartColor.amber
															: chartColor.emerald,
												}}
											/>
										</div>
									) : null}
									<p css={noteCss}>{meter.status}</p>
								</div>
							))}
							{billing.creditsAlarm ? (
								<SiteLink
									href={`${base}/usage#credits`}
									css={{
										...barLinkCss,
										borderLeft: `3px solid ${chartColor.amber}`,
										paddingLeft: '0.75rem',
									}}
								>
									<strong>{billing.creditsAlarm.title}</strong>
									<span css={mutedCss}>{billing.creditsAlarm.body}</span>
								</SiteLink>
							) : null}
						</div>
					</div>
				</section>
			) : null}
		</div>
	)
}

const gridCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
	gap: '1.25rem',
	'@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
}
const panelCss = dashboardPanelCss
const headerCss = dashboardHeaderCss
const headingCss = dashboardHeadingCss
const mutedCss: CSSObject = { fontSize: '0.8rem', color: colors.textMuted }
const bodyCss: CSSObject = { padding: '0.75rem 1.25rem 1.25rem' }
const billingGridCss: CSSObject = {
	...bodyCss,
	display: 'grid',
	gap: '1rem',
	gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
	'@media (max-width: 700px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
}
const legendCss: CSSObject = {
	display: 'flex',
	gap: '1rem',
	flexWrap: 'wrap',
	fontSize: '0.8rem',
}
const noteCss: CSSObject = {
	...mutedCss,
	margin: '0.5rem 0 0',
	lineHeight: 1.4,
}
const labelCss: CSSObject = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: '0.75rem',
	fontSize: '0.85rem',
	alignItems: 'baseline',
}
const barLinkCss: CSSObject = {
	display: 'grid',
	gap: '0.4rem',
	textDecoration: 'none',
	color: colors.text,
	'&:hover': { color: colors.primaryText },
}
const trackCss: CSSObject = {
	display: 'block',
	height: 7,
	borderRadius: 4,
	overflow: 'hidden',
	background: colors.border,
	marginTop: '0.4rem',
}
const fillCss: CSSObject = { display: 'block', height: '100%', borderRadius: 4 }
const emptyCss: CSSObject = {
	margin: '0.5rem 0',
	fontSize: '0.875rem',
	color: colors.textMuted,
}
const moreCss = dashboardLinkCss
