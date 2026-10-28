/** @jsxImportSource @emotion/react */
import { SkillMetricsPanel } from './skill-metrics.tsx'
import { type SkillMetrics } from '#universal/skill-metrics.ts'
import { EntityExplainer, resolveEntityExplainer } from './entity-explainer.tsx'
import { WorkspaceCharts } from './workspace-charts.tsx'
import {
	type WorkspaceRunCharts,
	type WorkspaceBilling,
} from '#universal/workspace-charts.ts'
import { type CSSObject } from '@emotion/react'
import {
	type AccountActivityRunListItem,
	type AccountActivitySummary,
} from '#app/account-activity-data.ts'
import { type AccountJobListItem } from '#app/account-jobs-data.ts'
import { type PublicProfilePackageItem } from '#universal/community-public-types.ts'
import { AccountManagementShell } from './account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { formatTimestamp } from '../components/local-timestamp.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	runDisplayName,
	statusColor,
	statusLabel,
} from './account-activity-shared.ts'
import {
	dashboardPanelCss,
	dashboardHeaderCss,
	dashboardHeadingCss,
	dashboardLinkCss,
	dashboardIconCss,
} from './workspace-dashboard-styles.ts'
import { colors } from '#universal/styles/tokens.ts'

type OverviewData = {
	skillMetrics: SkillMetrics
	charts: WorkspaceRunCharts
	billing: WorkspaceBilling | null
	slug: string
	repositories: Array<PublicProfilePackageItem>
	summary: AccountActivitySummary
	runs: Array<AccountActivityRunListItem>
	upcomingJobs: Array<AccountJobListItem>
}

export function WorkspaceOverview({ data }: { data: OverviewData }) {
	const explainer = resolveEntityExplainer('overview')
	const base = `/@${encodeURIComponent(data.slug)}/-`
	const activity = `${base}/activity?view=recent&status=all&triage=all`
	return (
		<AccountManagementShell layout="dashboard" currentHref={`${base}/overview`}>
			<div
				css={dashboardCss}
				data-workspace-overview
				data-testid="workspace-dashboard"
			>
				<div css={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
					<h1 css={{ margin: 0, fontSize: '1.5rem', lineHeight: 1.3 }}>
						Overview
					</h1>
					{explainer ? <EntityExplainer copy={explainer} /> : null}
				</div>
				<section aria-labelledby="execution-summary">
					<h2 id="execution-summary" css={headingCss}>
						Executions <span css={mutedCss}>Last 7 days</span>
					</h2>
					<div css={summaryCss}>
						{[
							{
								label: 'Total runs',
								icon: 'play' as const,
								value: data.summary.total,
								href: activity,
							},
							{
								label: 'Running',
								icon: 'refresh' as const,
								value: data.summary.running,
								href: `${base}/activity?view=recent&status=running&triage=all`,
							},
							{
								label: 'Open errors',
								icon: 'warning-triangle' as const,
								hint: 'Untriaged, all retained',
								value: data.summary.errors,
								href: `${base}/activity?view=errors&status=error&triage=open`,
							},
						].map((item) => (
							<SiteLink key={item.label} href={item.href} css={metricCss}>
								<span
									css={{
										...dashboardIconCss,
										...(item.label === 'Open errors' && item.value > 0
											? {
													color: colors.danger,
													background: `color-mix(in srgb, ${colors.danger} 10%, transparent)`,
												}
											: {}),
									}}
								>
									{renderIcon(item.icon, { size: '1.15rem' })}
								</span>
								<span css={metricCopyCss}>
									<span css={mutedCss}>
										{item.label}
										{'hint' in item && item.hint ? (
											<span css={hintCss}> · {item.hint}</span>
										) : null}
									</span>
									<strong
										css={{
											fontSize: '1.9rem',
											fontVariantNumeric: 'tabular-nums',
											letterSpacing: '-0.04em',
											fontWeight: 650,
											lineHeight: 1.2,
										}}
									>
										{item.value.toLocaleString('en-US')}
									</strong>
								</span>
							</SiteLink>
						))}
					</div>
				</section>

				<WorkspaceCharts
					charts={data.charts}
					billing={data.billing}
					base={base}
				/>
				<div css={columnsCss}>
					<div css={stackCss}>
						<section css={panelCss} aria-labelledby="recent-repositories">
							<div css={panelHeaderCss}>
								<h2 id="recent-repositories" css={headingCss}>
									{renderIcon('box')} Recent repositories
								</h2>
								<SiteLink href={`${base}/repositories`} css={moreCss}>
									View all
								</SiteLink>
							</div>
							{data.repositories.length ? (
								<ul css={listCss}>
									{data.repositories.map((repo) => (
										<li key={repo.kodyId}>
											<SiteLink
												href={`/@${encodeURIComponent(data.slug)}/${encodeURIComponent(repo.kodyId)}`}
												css={rowCss}
											>
												<span aria-hidden="true" css={iconCss}>
													{renderIcon('box', { size: '1.2rem' })}
												</span>
												<span css={copyCss}>
													<strong css={nameCss}>{repo.name}</strong>
													<span css={mutedCss}>
														Updated {formatTimestamp(repo.updatedAt)}
													</span>
												</span>
												<span css={mutedCss}>
													{repo.isPrivate ? 'Private' : 'Public'}
												</span>
											</SiteLink>
										</li>
									))}
								</ul>
							) : (
								<div css={emptyCss}>
									<p>No repositories yet.</p>
									<SiteLink href={`${base}/agents`}>
										Connect an agent to start building
									</SiteLink>
								</div>
							)}
						</section>
						<section css={panelCss} aria-labelledby="recent-activity">
							<div css={panelHeaderCss}>
								<h2 id="recent-activity" css={headingCss}>
									{renderIcon('chart')} Recent activity
								</h2>
								<SiteLink href={activity} css={moreCss}>
									View all
								</SiteLink>
							</div>
							{data.runs.length ? (
								<ul css={listCss}>
									{data.runs.map((run) => (
										<li key={run.id}>
											<SiteLink
												href={`${activity}&selected=${encodeURIComponent(run.id)}`}
												css={rowCss}
											>
												<span css={copyCss}>
													<strong css={nameCss}>{runDisplayName(run)}</strong>
													<span css={mutedCss}>
														{formatTimestamp(run.startedAt)}
													</span>
												</span>
												<span
													css={{
														...statusCss,
														color: statusColor(run.status),
														background: `color-mix(in srgb, ${statusColor(run.status)} 8%, transparent)`,
													}}
												>
													{statusLabel(run.status)}
												</span>
											</SiteLink>
										</li>
									))}
								</ul>
							) : (
								<p css={emptyCss}>No executions in the last 7 days.</p>
							)}
						</section>
					</div>
					<div
						css={{
							...stackCss,
							'@media (min-width: 601px) and (max-width: 1100px)': {
								gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
								alignItems: 'start',
							},
						}}
					>
						<SkillMetricsPanel
							metrics={data.skillMetrics}
							href={`${base}/skills`}
							compact
						/>
						<section css={panelCss} aria-labelledby="upcoming-jobs">
							<div css={panelHeaderCss}>
								<h2 id="upcoming-jobs" css={headingCss}>
									{renderIcon('clock')} Upcoming jobs
								</h2>
								<SiteLink href={`${base}/jobs`} css={moreCss}>
									View all
								</SiteLink>
							</div>
							{data.upcomingJobs.length ? (
								<ul css={listCss}>
									{data.upcomingJobs.map((job) => (
										<li key={job.id}>
											<SiteLink
												href={`${base}/jobs?selected=${encodeURIComponent(job.id)}`}
												css={rowCss}
											>
												<span css={copyCss}>
													<strong css={nameCss}>{job.name}</strong>
													<span css={mutedCss}>
														{job.dueNow
															? 'Due now'
															: formatTimestamp(job.nextRunAt)}
													</span>
													<span css={mutedCss}>{job.scheduleSummary}</span>
												</span>
											</SiteLink>
										</li>
									))}
								</ul>
							) : (
								<p css={emptyCss}>No jobs scheduled.</p>
							)}
						</section>
					</div>
				</div>
			</div>
		</AccountManagementShell>
	)
}

const dashboardCss: CSSObject = {
	display: 'grid',
	gap: '1.25rem',
	'& a:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 3,
	},
}
const columnsCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1.6fr) minmax(16rem, 1fr)',
	alignItems: 'start',
	gap: '1.25rem',
	'@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
}
const stackCss: CSSObject = { display: 'grid', gap: '1.25rem', minWidth: 0 }
const headingCss: CSSObject = {
	...dashboardHeadingCss,
	flexWrap: 'wrap',
}
const mutedCss: CSSObject = {
	fontSize: '0.8rem',
	fontWeight: 400,
	color: colors.textMuted,
}
const hintCss: CSSObject = {
	fontWeight: 400,
	opacity: 0.85,
}
const summaryCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))',
	gap: '0.75rem',
	marginTop: '0.75rem',
	'@media (max-width: 600px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
}
const metricCopyCss: CSSObject = {
	display: 'grid',
	gap: '0.35rem',
	minWidth: 0,
}
const metricCss: CSSObject = {
	...dashboardPanelCss,
	display: 'flex',
	alignItems: 'center',
	gap: '1rem',
	padding: '1.25rem',
	color: colors.text,
	textDecoration: 'none',
	'&:hover': {
		borderColor: `color-mix(in srgb, ${colors.primary} 20%, transparent)`,
	},
	'@media (max-width: 600px)': { padding: '1rem', gap: '0.75rem' },
}
const panelCss = dashboardPanelCss
const panelHeaderCss = dashboardHeaderCss
const moreCss = dashboardLinkCss
const listCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	'& > li + li': { borderTop: `1px solid ${colors.borderSubtle}` },
}
const rowCss: CSSObject = {
	display: 'flex',
	gap: '0.75rem',
	alignItems: 'center',
	padding: '1rem 1.25rem',
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { background: colors.primarySoftest },
}
const copyCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	flex: 1,
	minWidth: 0,
	overflowWrap: 'anywhere',
}
const nameCss: CSSObject = { fontSize: '0.875rem', fontWeight: 600 }
const iconCss = dashboardIconCss
const statusCss: CSSObject = {
	padding: '0.3rem 0.55rem',
	borderRadius: '0.5rem',
	fontSize: '0.8rem',
	fontWeight: 550,
	flexShrink: 0,
}
const emptyCss: CSSObject = {
	margin: 0,
	padding: '0.8rem',
	fontSize: '0.875rem',
	color: colors.textMuted,
	'& p': { margin: '0 0 0.5rem' },
}
