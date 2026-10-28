/** @jsxImportSource @emotion/react */
import {
	type SkillReadChannel,
	type SkillMetrics,
} from '#universal/skill-metrics.ts'
import {
	dashboardPanelCss,
	dashboardHeaderCss,
	dashboardHeadingCss,
	dashboardLinkCss,
} from './workspace-dashboard-styles.ts'
import { colors } from '#universal/styles/tokens.ts'
import { chartColor } from '#client/charts/chart-theme.ts'
import { DonutChart } from '../charts/donut-chart.tsx'
import { StackedBarChart } from '../charts/stacked-bar-chart.tsx'
import { ChartLegend } from '../components/chart-legend.tsx'
import { renderIcon } from '../components/icon.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { formatTimestamp } from '../components/local-timestamp.tsx'

const skillColors = [
	chartColor.emerald,
	chartColor.blue,
	chartColor.violet,
	chartColor.amber,
	chartColor.teal,
]

const channelLabels: Record<SkillReadChannel, string> = {
	'skills-page': 'Skills viewer',
	'mcp-resource': 'MCP resource',
	search: 'Agent search',
	'package-api': 'Repository API',
	'package-file': 'Package viewer',
	'raw-file': 'Raw file',
}

export function SkillMetricsPanel({
	metrics,
	href,
	compact = false,
}: {
	metrics: SkillMetrics
	href: string
	compact?: boolean
}) {
	const start = new Date(metrics.since)
	start.setUTCHours(0, 0, 0, 0)
	const days = Array.from({ length: 31 }, (_, index) =>
		new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10),
	)
	const series: Array<{ label: string; color: string; values: Array<number> }> =
		metrics.topSkills.map((skill, index) => ({
			label: metrics.topSkills.some(
				(other) => other.uri !== skill.uri && other.name === skill.name,
			)
				? `${skill.name} · ${skill.packageName}`
				: skill.name,
			color: skillColors[index] ?? chartColor.emerald,
			values: days.map(
				(day) =>
					metrics.dailyReads.find(
						(entry) => entry.day === day && entry.skillUri === skill.uri,
					)?.reads ?? 0,
			),
		}))
	if (metrics.dailyReads.some((entry) => entry.skillUri === null)) {
		series.push({
			label: 'Other',
			color: colors.textMuted,
			values: days.map(
				(day) =>
					metrics.dailyReads.find(
						(entry) => entry.day === day && entry.skillUri === null,
					)?.reads ?? 0,
			),
		})
	}
	if (compact) {
		return (
			<section css={dashboardPanelCss} aria-label="Skills overview">
				<div css={dashboardHeaderCss}>
					<h2 css={dashboardHeadingCss}>{renderIcon('chart')} Skills</h2>
					<SiteLink
						href={href}
						css={dashboardLinkCss}
						aria-label="View all skills"
					>
						View all
					</SiteLink>
				</div>
				<div css={{ padding: '0 1.25rem 1rem' }}>
					<dl
						css={{
							display: 'flex',
							gap: '1.25rem',
							margin: '0 0 0.75rem',
							fontVariantNumeric: 'tabular-nums',
						}}
					>
						{[
							['Published', metrics.skillCount],
							['Reads · 30d', metrics.instructionReads],
							['Readers · 30d', metrics.readers],
						].map(([label, value]) => (
							<div key={label}>
								<dt css={{ fontSize: '0.75rem', color: colors.textMuted }}>
									{label}
								</dt>
								<dd
									css={{
										margin: '0.2rem 0 0',
										fontSize: '1.4rem',
										fontWeight: 650,
										lineHeight: 1.2,
									}}
								>
									{value?.toLocaleString('en-US')}
								</dd>
							</div>
						))}
					</dl>
					<StackedBarChart
						id="overview-skill-reads"
						series={series}
						xLabels={days.map((day) => day.slice(5))}
						ariaLabel="Daily skill reads over the last 30 days, UTC"
						height={100}
						viewBoxWidth={200}
						xTickEvery={14}
					/>
				</div>
			</section>
		)
	}

	return (
		<section
			aria-label="Skill metrics"
			css={{
				border: `1px solid ${colors.border}`,
				borderRadius: '0.5rem',
				padding: '1rem',
				marginBottom: '1rem',
			}}
		>
			<div
				css={{
					display: 'flex',
					justifyContent: 'space-between',
					gap: '1rem',
					alignItems: 'baseline',
				}}
			>
				<h2 css={{ fontSize: '1.1rem', margin: 0 }}>
					{compact ? <SiteLink href={href}>Skills</SiteLink> : 'Reads'}
				</h2>
				<span css={{ color: colors.textMuted }}>Last 30 days</span>
			</div>
			<dl
				css={{
					display: 'grid',
					gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
					gap: '1rem',
				}}
			>
				{[
					['Published skills', metrics.skillCount],
					['Packages with skills', metrics.packageCount],
					['Instruction reads', metrics.instructionReads],
					['Supporting-file reads', metrics.supportingFileReads],
					['Readers', metrics.readers],
				]
					.filter(
						([label]) =>
							!compact ||
							(label !== 'Packages with skills' &&
								label !== 'Supporting-file reads'),
					)
					.map(([label, value]) => (
						<div key={label}>
							<dt css={{ color: colors.textMuted, fontSize: '0.85rem' }}>
								{label}
							</dt>
							<dd
								css={{
									margin: '0.25rem 0 0',
									fontSize: '1.4rem',
									fontWeight: 600,
								}}
							>
								{value?.toLocaleString('en-US')}
							</dd>
						</div>
					))}
			</dl>
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: compact
						? '1fr'
						: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
					gap: '1.5rem',
				}}
			>
				{!compact ? (
					<div css={{ minWidth: 0 }}>
						<h3 css={{ fontSize: '0.9rem', margin: '1rem 0 0.5rem' }}>
							Daily skill reads (UTC)
						</h3>
						<StackedBarChart
							id="skill-daily-reads"
							series={series}
							xLabels={days.map((day) => day.slice(5))}
							ariaLabel="Daily instruction reads by skill over the last 30 days"
							height={180}
							viewBoxWidth={400}
							xTickEvery={7}
						/>
						<ChartLegend items={series} />
					</div>
				) : null}
				{metrics.topSkills.length > 0 ? (
					<div>
						<h3 css={{ fontSize: '0.9rem', margin: '1rem 0 0.5rem' }}>
							Most read
						</h3>
						<div css={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
							{!compact ? (
								<DonutChart
									showLegend={false}
									size={120}
									centerLabel="Reads"
									ariaLabel="Instruction reads among the five most-read skills"
									slices={metrics.topSkills.map((skill, index) => ({
										label: `${skill.name} · ${skill.packageName}`,
										value: skill.reads,
										color: skillColors[index] ?? chartColor.emerald,
									}))}
								/>
							) : null}
							<ul
								css={{
									padding: 0,
									margin: 0,
									listStyle: 'none',
									flex: 1,
									minWidth: 0,
								}}
							>
								{metrics.topSkills
									.slice(0, compact ? 3 : 5)
									.map((skill, index) => (
										<li
											key={skill.uri}
											css={{
												display: 'flex',
												gap: '0.5rem',
												justifyContent: 'space-between',
												padding: '0.3rem 0',
												position: 'relative',
												flexWrap: 'wrap',
											}}
										>
											{!compact ? (
												<span
													aria-hidden="true"
													css={{
														width: '0.5rem',
														height: '0.5rem',
														borderRadius: '50%',
														flexShrink: 0,
														marginTop: '0.45rem',
														background: skillColors[index],
													}}
												/>
											) : null}
											<SiteLink
												href={`${href}?skill=${encodeURIComponent(skill.uri)}`}
												css={{ overflowWrap: 'anywhere', flex: 1 }}
											>
												{skill.name}{' '}
												<span css={{ color: colors.textMuted }}>
													{' '}
													· {skill.packageName}
												</span>
											</SiteLink>
											<span css={{ whiteSpace: 'nowrap' }}>
												{skill.reads} {skill.reads === 1 ? 'read' : 'reads'}
											</span>
										</li>
									))}
							</ul>
						</div>
					</div>
				) : (
					<p css={{ color: colors.textMuted, marginBottom: 0 }}>
						No skill reads recorded in the last 30 days.
					</p>
				)}
			</div>
			{!compact ? (
				<>
					<p css={{ color: colors.textMuted, fontSize: '0.85rem' }}>
						Reads record files opened in Kody or fetched by connected agents,
						not confirmed execution. Cached and offline reads aren't visible.
					</p>
					{metrics.recentReads.length > 0 ? (
						<details>
							<summary css={{ cursor: 'pointer' }}>Recent reads</summary>
							<div css={{ overflowX: 'auto' }}>
								<table
									css={{
										width: '100%',
										borderCollapse: 'collapse',
										fontSize: '0.85rem',
										'& th, & td': {
											padding: '0.5rem',
											textAlign: 'left',
											borderBottom: `1px solid ${colors.border}`,
										},
									}}
								>
									<thead>
										<tr>
											<th>Reader</th>
											<th>File</th>
											<th>Source</th>
											<th>When</th>
										</tr>
									</thead>
									<tbody>
										{metrics.recentReads.map((read) => (
											<tr key={read.id}>
												<td>
													{read.actorUsername ??
														read.actorId ??
														(read.attribution.kind === 'automation'
															? `${read.attribution.source} automation`
															: 'Unknown reader')}
												</td>
												<td>
													<SiteLink
														href={`${href}?skill=${encodeURIComponent(read.skillUri)}`}
													>
														{read.packageName}/{read.filePath}
													</SiteLink>
												</td>
												<td>
													{channelLabels[read.channel]}
													{read.profileName ? ` · ${read.profileName}` : ''}
												</td>
												<td css={{ whiteSpace: 'nowrap' }}>
													{formatTimestamp(read.occurredAt)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</details>
					) : null}
				</>
			) : null}
		</section>
	)
}
