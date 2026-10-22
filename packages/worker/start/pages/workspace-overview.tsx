/** @jsxImportSource @emotion/react */
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
import { colors } from '#universal/styles/tokens.ts'

type OverviewData = {
	charts: WorkspaceRunCharts
	billing: WorkspaceBilling | null
	slug: string
	repositories: Array<PublicProfilePackageItem>
	summary: AccountActivitySummary
	runs: Array<AccountActivityRunListItem>
	upcomingJobs: Array<AccountJobListItem>
}

export function WorkspaceOverview({ data }: { data: OverviewData }) {
	const base = `/@${encodeURIComponent(data.slug)}/-`
	const activity = `${base}/activity?view=recent&status=all&triage=all`
	return (
		<AccountManagementShell layout="dashboard" currentHref={`${base}/overview`}>
			<div css={dashboardCss} data-testid="workspace-dashboard">
				<h1 css={{ margin: 0, fontSize: '1.5rem', lineHeight: 1.3 }}>
					Overview
				</h1>
				<section aria-labelledby="execution-summary">
					<h2 id="execution-summary" css={headingCss}>
						Executions <span css={mutedCss}>Last 7 days</span>
					</h2>
					<div css={summaryCss}>
						{[
							{
								label: 'Total runs',
								value: data.summary.total,
								href: activity,
							},
							{
								label: 'Running',
								value: data.summary.running,
								href: `${base}/activity?view=recent&status=running&triage=all`,
							},
							{
								label: 'Open errors',
								value: data.summary.errors,
								href: `${base}/activity?view=errors&status=error&triage=open`,
							},
						].map((item) => (
							<SiteLink key={item.label} href={item.href} css={metricCss}>
								<span css={mutedCss}>{item.label}</span>
								<strong
									css={{
										fontSize: '1.35rem',
										fontWeight: 650,
										lineHeight: 1.2,
									}}
								>
									{item.value.toLocaleString('en-US')}
								</strong>
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
									Recent repositories
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
									Recent activity
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
													css={{ ...statusCss, color: statusColor(run.status) }}
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
					<section css={panelCss} aria-labelledby="upcoming-jobs">
						<div css={panelHeaderCss}>
							<h2 id="upcoming-jobs" css={headingCss}>
								Upcoming jobs
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
		</AccountManagementShell>
	)
}

const dashboardCss: CSSObject = { display: 'grid', gap: '1rem' }
const columnsCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1.6fr) minmax(16rem, 1fr)',
	alignItems: 'start',
	gap: '0.75rem',
	'@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
}
const stackCss: CSSObject = { display: 'grid', gap: '0.75rem', minWidth: 0 }
const headingCss: CSSObject = {
	margin: 0,
	fontSize: '0.875rem',
	fontWeight: 650,
	display: 'flex',
	alignItems: 'baseline',
	flexWrap: 'wrap',
	gap: '0.75rem',
}
const mutedCss: CSSObject = {
	fontSize: '0.8rem',
	fontWeight: 400,
	color: colors.textMuted,
}
const summaryCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
	gap: '0.75rem',
	marginTop: '0.75rem',
}
const metricCss: CSSObject = {
	display: 'grid',
	gap: '0.25rem',
	padding: '0.65rem 0.8rem',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.5rem',
	color: colors.text,
	textDecoration: 'none',
	background: colors.surface,
	'&:hover': { borderColor: colors.primary },
}
const panelCss: CSSObject = {
	border: `1px solid ${colors.border}`,
	borderRadius: '0.5rem',
	background: colors.surface,
	minWidth: 0,
	overflow: 'hidden',
}
const panelHeaderCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '1rem',
	padding: '0.65rem 0.8rem',
	borderBottom: `1px solid ${colors.border}`,
}
const moreCss: CSSObject = {
	fontSize: '0.8rem',
	whiteSpace: 'nowrap',
	color: colors.primaryText,
}
const listCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	'& > li + li': { borderTop: `1px solid ${colors.border}` },
}
const rowCss: CSSObject = {
	display: 'flex',
	gap: '0.75rem',
	alignItems: 'center',
	padding: '0.65rem 0.8rem',
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
const nameCss: CSSObject = { fontSize: '0.8125rem', fontWeight: 600 }
const iconCss: CSSObject = { display: 'flex', color: colors.textMuted }
const statusCss: CSSObject = {
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
