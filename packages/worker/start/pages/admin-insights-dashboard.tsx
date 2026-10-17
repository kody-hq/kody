/** @jsxImportSource @emotion/react */

import { AreaChart } from '../charts/area-chart.tsx'
import { ChartLegend } from '../charts/chart-legend.tsx'
import { DonutChart } from '../charts/donut-chart.tsx'
import { HeatmapChart } from '../charts/heatmap-chart.tsx'
import { StackedBarChart } from '../charts/stacked-bar-chart.tsx'
import { StatCard } from '../charts/stat-card.tsx'
import {
	chartColor,
	formatCompactNumber,
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'
import {
	formatMonthKeyLabel,
	usageMetricSeries,
} from '#client/charts/usage-metric-series.ts'
import { dynamicWorkerCostFootnote } from '#universal/dynamic-worker-cost.ts'
import { AccountManagementMessage } from './account-management-components.tsx'
import { type AdminInsightsLoaderData } from '#universal/loader-data.ts'
import {
	authCategoryColors,
	formatDayLabel,
	formatPlanLabel,
	formatRunLogCompletenessWarning,
	planColors,
	workflowStatusColors,
} from '#client/routes/admin-insights-shared.ts'
import { renderCostVsPay } from './admin-insights-cost.tsx'
import {
	renderLaunchSignals,
	renderOnboardingFunnelSummary,
} from './admin-insights-launch.tsx'
import {
	ChartCard,
	ChartGrid,
	StatGrid,
	activationSubtitle,
	renderActivationFunnel,
	renderDurationByMetric,
	renderDurationConsumers,
	renderDynamicWorkerCost,
	renderEntitlementPressure,
	renderEventCountConsumers,
	renderPackageErrorRate,
} from './admin-insights-sections.tsx'

export function renderDashboard(data: AdminInsightsLoaderData) {
	const signupWeeks = data.signupsByWeek
	const latestWeek = signupWeeks[signupWeeks.length - 1]
	const weekLabels = signupWeeks.map((week) => formatDayLabel(week.weekStart))
	const monthLabels = data.usageByMonth.map((month) =>
		formatMonthKeyLabel(month.month),
	)
	const dayLabels = data.emailByDay.map((day) => formatDayLabel(day.day))
	const authDayLabels = data.authByDay.map((day) => formatDayLabel(day.day))
	const totalAuthEvents = data.authByCategory.reduce(
		(sum, entry) => sum + entry.count,
		0,
	)
	const totalJobRuns = data.jobHealth.successRuns + data.jobHealth.errorRuns
	const emailWindowTotal = data.emailByDay.reduce(
		(sum, day) => sum + day.sends + day.receives,
		0,
	)
	const verifiedShare =
		data.totals.users > 0 ? data.totals.verifiedUsers / data.totals.users : 0
	const runLogWarning = formatRunLogCompletenessWarning(data.runLogCompleteness)

	return (
		<>
			{runLogWarning ? (
				<AccountManagementMessage tone="info">
					{runLogWarning}
				</AccountManagementMessage>
			) : null}
			{renderLaunchSignals(data.launchSignals)}
			{renderOnboardingFunnelSummary(data.onboardingFunnel)}
			<ChartGrid>{renderCostVsPay(data.dynamicWorkerCost)}</ChartGrid>
			<StatGrid>
				<StatCard
					id="stat-users"
					label="Users"
					value={formatIntegerNumber(data.totals.users)}
					sub={`${formatPercentShare(verifiedShare)} verified · +${formatIntegerNumber(latestWeek?.signups ?? 0)} this week`}
					color={chartColor.blue}
					sparkValues={signupWeeks.map((week) => week.cumulativeUsers)}
				/>
				<StatCard
					id="stat-packages"
					label="Saved packages"
					value={formatIntegerNumber(data.totals.savedPackages)}
					sub={`${formatIntegerNumber(data.totals.activeCommunityListings)} community listings`}
					color={chartColor.emerald}
				/>
				<StatCard
					id="stat-jobs"
					label="Scheduled jobs"
					value={formatIntegerNumber(data.totals.scheduledJobs)}
					sub={`${formatIntegerNumber(data.totals.enabledJobs)} enabled · ${formatIntegerNumber(totalJobRuns)} runs recorded`}
					color={chartColor.amber}
				/>
				<StatCard
					id="stat-workflows"
					label="Workflow runs"
					value={formatIntegerNumber(data.totals.workflowRuns)}
					sub="All-time durable runs"
					color={chartColor.violet}
				/>
				<StatCard
					id="stat-memories"
					label="Active memories"
					value={formatIntegerNumber(data.totals.activeMemories)}
					sub="Long-term assistant memory"
					color={chartColor.rose}
				/>
				<StatCard
					id="stat-email"
					label="Stored emails"
					value={
						data.totals.storedEmailMessages == null
							? 'Unavailable'
							: formatIntegerNumber(data.totals.storedEmailMessages)
					}
					sub={`${formatCompactNumber(emailWindowTotal)} sent + received in 28 days`}
					color={chartColor.cyan}
					sparkValues={data.emailByDay.map((day) => day.sends + day.receives)}
				/>
				<StatCard
					id="stat-secrets"
					label="Secrets"
					value={formatIntegerNumber(data.totals.secrets)}
					sub="Encrypted references (values never shown)"
					color={chartColor.lime}
				/>
				<StatCard
					id="stat-signin"
					label="Sign-in methods"
					value={formatIntegerNumber(
						data.totals.passkeys + data.totals.oauthConnections,
					)}
					sub={`${formatIntegerNumber(data.totals.passkeys)} passkeys · ${formatIntegerNumber(data.totals.oauthConnections)} social links`}
					color={chartColor.fuchsia}
				/>
			</StatGrid>

			<ChartGrid>
				<ChartCard
					title="Package activation"
					sub={activationSubtitle(data.activation)}
					span={8}
				>
					{renderActivationFunnel(data.activation)}
				</ChartCard>
				<ChartCard
					title="Who forks packages"
					sub="Agent-driven installs are real usage but a weaker activation signal than a person choosing one."
					span={4}
				>
					<DonutChart
						ariaLabel="Community forks by actor"
						centerLabel="forks"
						emptyText="No forks recorded yet."
						slices={[
							{
								label: 'Person',
								value: data.activation.forksByActor.human,
								color: chartColor.emerald,
							},
							{
								label: 'Agent',
								value: data.activation.forksByActor.agent,
								color: chartColor.violet,
							},
							{
								label: 'Unknown',
								value: data.activation.forksByActor.unknown,
								color: chartColor.amber,
							},
						]}
					/>
				</ChartCard>

				<ChartCard
					title="User growth"
					sub="Cumulative registered users over the last 12 weeks."
					span={8}
				>
					<AreaChart
						id="growth"
						ariaLabel="Cumulative registered users per week"
						series={[
							{
								label: 'Total users',
								color: chartColor.blue,
								values: signupWeeks.map((week) => week.cumulativeUsers),
							},
						]}
						xLabels={weekLabels}
					/>
				</ChartCard>
				<ChartCard title="New signups" sub="Fresh accounts per week." span={4}>
					<StackedBarChart
						id="signups"
						ariaLabel="New signups per week"
						series={[
							{
								label: 'Signups',
								color: chartColor.emerald,
								values: signupWeeks.map((week) => week.signups),
							},
						]}
						xLabels={weekLabels}
						xTickEvery={3}
						viewBoxWidth={360}
					/>
				</ChartCard>

				<ChartCard
					title="Platform activity"
					sub="Metered events across all accounts by month, from the usage rollups."
					span={12}
					legend={
						<ChartLegend
							items={usageMetricSeries.map((entry) => ({
								label: entry.label,
								color: entry.color,
							}))}
						/>
					}
				>
					<StackedBarChart
						id="activity"
						ariaLabel="Metered platform events by month"
						series={usageMetricSeries.map((entry) => ({
							label: entry.label,
							color: entry.color,
							values: data.usageByMonth.map(
								(month) => month.events[entry.metric] ?? 0,
							),
						}))}
						xLabels={monthLabels}
						xTickEvery={1}
					/>
				</ChartCard>

				<ChartCard
					title="Top runtime consumers"
					sub="Combined execute, job, and workflow runtime duration for the current UTC month."
					span={6}
				>
					{renderDurationConsumers(
						data.topRuntimeDurationConsumers,
						'Top combined runtime duration consumers this month',
					)}
				</ChartCard>
				<ChartCard
					title="Top event consumers"
					sub="Total metered events across all metrics for the current UTC month."
					span={6}
				>
					{renderEventCountConsumers(data.topEventCountConsumers)}
				</ChartCard>
				<ChartCard
					title="Dynamic Worker cost"
					sub={dynamicWorkerCostFootnote}
					span={6}
				>
					{renderDynamicWorkerCost(data.dynamicWorkerCost)}
				</ChartCard>

				<ChartCard
					title="Runtime leaders by metric"
					sub="Per-metric duration leaders for execute, jobs, and workflows."
					span={6}
				>
					{renderDurationByMetric(data.topDurationConsumersByMetric)}
				</ChartCard>
				<ChartCard
					title="Entitlement pressure"
					sub="Accounts above 80% of a plan limit among the ~15 most active users this month. Bounded usage_rollups sweep — not a full user scan."
					span={6}
				>
					{renderEntitlementPressure(data.entitlementPressure)}
				</ChartCard>
				<ChartCard
					title="Fleet package error rate"
					sub="Analytics Engine rates for user-package runtime metrics. Rising rates page admin packages. Concentrated spikes name the owning accounts."
					span={6}
				>
					{renderPackageErrorRate(data.packageErrorRate)}
				</ChartCard>

				<ChartCard
					title="Email traffic"
					sub="Daily sends and receives across every inbox, last 28 days."
					span={8}
					legend={
						<ChartLegend
							items={[
								{ label: 'Sends', color: chartColor.cyan },
								{ label: 'Receives', color: chartColor.violet },
							]}
						/>
					}
				>
					<AreaChart
						id="email"
						ariaLabel="Email sends and receives per day"
						series={[
							{
								label: 'Sends',
								color: chartColor.cyan,
								values: data.emailByDay.map((day) => day.sends),
							},
							{
								label: 'Receives',
								color: chartColor.violet,
								values: data.emailByDay.map((day) => day.receives),
							},
						]}
						xLabels={dayLabels}
					/>
				</ChartCard>
				<ChartCard
					title="Orgs by plan"
					sub="Manual grant on `orgs.plan` only — not Stripe or overlays. See Plan sources above."
					span={4}
				>
					<DonutChart
						ariaLabel="Orgs by plan"
						centerLabel="orgs"
						slices={data.plans.map((slice, index) => ({
							label: formatPlanLabel(slice.plan),
							value: slice.count,
							color:
								planColors[slice.plan] ??
								[chartColor.amber, chartColor.rose, chartColor.lime][
									index % 3
								] ??
								chartColor.amber,
						}))}
					/>
				</ChartCard>

				<ChartCard
					title="Email delivery health"
					sub="Outbound delivery outcomes from the provider, last 28 days. Bounces and complaints burn the shared sender domain's reputation."
					span={12}
					legend={
						<ChartLegend
							items={[
								{ label: 'Delivered', color: chartColor.emerald },
								{ label: 'Deferred', color: chartColor.cyan },
								{ label: 'Bounced', color: chartColor.amber },
								{ label: 'Failed', color: chartColor.fuchsia },
								{ label: 'Rejected', color: chartColor.violet },
								{ label: 'Complained', color: chartColor.rose },
							]}
						/>
					}
				>
					<StackedBarChart
						id="email-delivery"
						ariaLabel="Outbound email delivery outcomes per day"
						series={[
							{
								label: 'Delivered',
								color: chartColor.emerald,
								values: data.emailDeliveryByDay.map((day) => day.delivered),
							},
							{
								label: 'Deferred',
								color: chartColor.cyan,
								values: data.emailDeliveryByDay.map((day) => day.deferred),
							},
							{
								label: 'Bounced',
								color: chartColor.amber,
								values: data.emailDeliveryByDay.map((day) => day.bounced),
							},
							{
								label: 'Failed',
								color: chartColor.fuchsia,
								values: data.emailDeliveryByDay.map((day) => day.failed),
							},
							{
								label: 'Rejected',
								color: chartColor.violet,
								values: data.emailDeliveryByDay.map((day) => day.rejected),
							},
							{
								label: 'Complained',
								color: chartColor.rose,
								values: data.emailDeliveryByDay.map((day) => day.complained),
							},
						]}
						xLabels={data.emailDeliveryByDay.map((day) =>
							formatDayLabel(day.day),
						)}
					/>
				</ChartCard>

				<ChartCard
					title="Auth pulse"
					sub="Authentication and account events per day, last 28 days."
					span={8}
					legend={
						<ChartLegend
							items={[
								{ label: 'Success', color: chartColor.emerald },
								{ label: 'Failure', color: chartColor.rose },
								{ label: 'Rate limited', color: chartColor.amber },
							]}
						/>
					}
				>
					<StackedBarChart
						id="auth"
						ariaLabel="Audit events per day by result"
						series={[
							{
								label: 'Success',
								color: chartColor.emerald,
								values: data.authByDay.map((day) => day.success),
							},
							{
								label: 'Failure',
								color: chartColor.rose,
								values: data.authByDay.map((day) => day.failure),
							},
							{
								label: 'Rate limited',
								color: chartColor.amber,
								values: data.authByDay.map((day) => day.rateLimited),
							},
						]}
						xLabels={authDayLabels}
					/>
				</ChartCard>
				<ChartCard
					title="Event categories"
					sub={`${formatIntegerNumber(totalAuthEvents)} audit events in 28 days.`}
					span={4}
				>
					<DonutChart
						ariaLabel="Audit events by category"
						centerLabel="events"
						slices={data.authByCategory.map((entry, index) => ({
							label: entry.category,
							value: entry.count,
							color:
								authCategoryColors[entry.category] ??
								[chartColor.cyan, chartColor.lime][index % 2] ??
								chartColor.cyan,
						}))}
					/>
				</ChartCard>

				<ChartCard
					title="When things happen"
					sub="Audit event activity by weekday and hour (UTC), last 28 days."
					span={8}
				>
					<HeatmapChart
						ariaLabel="Audit events by weekday and hour"
						cells={data.authHeatmap}
						color={chartColor.blue}
						unitLabel="events"
					/>
				</ChartCard>
				<ChartCard
					title="Workflow outcomes"
					sub="All durable workflow runs by status."
					span={4}
				>
					<DonutChart
						ariaLabel="Workflow runs by status"
						centerLabel="runs"
						slices={data.workflowStatuses.map((entry, index) => ({
							label: entry.status,
							value: entry.count,
							color:
								workflowStatusColors[entry.status] ??
								[chartColor.cyan, chartColor.lime, chartColor.fuchsia][
									index % 3
								] ??
								chartColor.cyan,
						}))}
					/>
				</ChartCard>

				<ChartCard
					title="Job run health"
					sub={`${formatIntegerNumber(data.jobHealth.enabledJobs)} of ${formatIntegerNumber(data.jobHealth.totalJobs)} scheduled jobs enabled.`}
					span={6}
				>
					<DonutChart
						ariaLabel="Job runs by outcome"
						centerLabel="job runs"
						emptyText="No job runs recorded yet."
						slices={[
							{
								label: 'Succeeded',
								value: data.jobHealth.successRuns,
								color: chartColor.emerald,
							},
							{
								label: 'Failed',
								value: data.jobHealth.errorRuns,
								color: chartColor.rose,
							},
						]}
					/>
				</ChartCard>
				<ChartCard
					title="Email verification"
					sub="Verified versus unverified accounts."
					span={6}
				>
					<DonutChart
						ariaLabel="Users by email verification"
						centerLabel="users"
						slices={[
							{
								label: 'Verified',
								value: data.totals.verifiedUsers,
								color: chartColor.blue,
							},
							{
								label: 'Unverified',
								value: data.totals.users - data.totals.verifiedUsers,
								color: chartColor.amber,
							},
						]}
					/>
				</ChartCard>
			</ChartGrid>
		</>
	)
}
