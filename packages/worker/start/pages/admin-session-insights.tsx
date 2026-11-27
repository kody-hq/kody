/** @jsxImportSource @emotion/react */
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useState } from 'react'
import {
	markAdminSessionPatternFixed,
	retireAdminSessionCategory,
} from '#start/server/admin-session-insights'
import type { AdminSessionInsights } from '#worker/session-analytics/insights.ts'
import {
	sessionInsightsMinOrgs,
	sessionInsightsMinSessions,
	sessionStuckKindLabels,
} from '#universal/session-analytics.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { Button } from '../components/button.tsx'
import { Table } from '../components/table.tsx'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
const numberCellCss = {
	textAlign: 'end' as const,
	fontVariantNumeric: 'tabular-nums',
	whiteSpace: 'nowrap' as const,
}
const tableScrollCss = { overflowX: 'auto' as const, minWidth: 0 }

function percent(value: number | null) {
	return value === null ? 'Not enough data' : `${Math.round(value * 100)}%`
}
function share(part: number, whole: number) {
	return whole > 0 ? `${Math.round((part / whole) * 100)}%` : 'None yet'
}

export function AdminSessionInsightsRoute({
	data,
	queryKey,
}: {
	data: AdminSessionInsights
	queryKey: QueryKey
}) {
	const currentHref = useMatchedPageScope().pageLocation.href
	const client = useQueryClient()
	const [error, setError] = useState<string | null>(null)
	const settle = {
		onSettled: () => client.invalidateQueries({ queryKey, exact: true }),
		onError: (failure: Error) => setError(failure.message),
		onMutate: () => setError(null),
	}
	const markFixed = useMutation({
		mutationFn: (fields: Parameters<typeof markAdminSessionPatternFixed>[0]) =>
			markAdminSessionPatternFixed(fields),
		...settle,
	})
	const retire = useMutation({
		mutationFn: (fields: Parameters<typeof retireAdminSessionCategory>[0]) =>
			retireAdminSessionCategory(fields),
		...settle,
	})
	const busy = markFixed.isPending || retire.isPending
	const { summary, labelChecks } = data
	const minimum = `at least ${sessionInsightsMinSessions} sessions from at least ${sessionInsightsMinOrgs} organizations`
	return (
		<AccountManagementShell
			layout="dashboard"
			currentHref={currentHref}
			maxWidth="min(100%, 92rem)"
		>
			<AdminPageHeader
				title="Session insights"
				description={`How agent sessions go across organizations that turned on session analytics. Combined totals only; a number shows once it has ${minimum}.`}
				currentHref={currentHref}
			/>
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel title={`Last ${data.windowDays} days`}>
				<MetadataGrid
					items={[
						{
							label: 'Organizations opted in',
							value: data.optedInOrgs.toLocaleString(),
						},
						...(summary
							? [
									{
										label: 'Sessions',
										value: summary.sessions.toLocaleString(),
									},
									{
										label: 'Ended without errors',
										value: share(summary.endedWithoutErrors, summary.sessions),
									},
									{
										label: 'Recovered after errors',
										value: share(summary.recovered, summary.sessions),
									},
									{
										label: 'Ended stuck',
										value: share(summary.stuck, summary.sessions),
									},
									{
										label: 'Sessions that got a hint',
										value: summary.nudgedSessions.toLocaleString(),
									},
								]
							: [{ label: 'Sessions', value: `Shown at ${minimum}` }]),
					]}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Where sessions get stuck"
				description="Ranked by sessions. Mark a pattern fixed to compare the share stuck before and after."
			>
				{data.patterns.length === 0 ? (
					<p css={mutedCss}>No stuck pattern is over the minimum yet.</p>
				) : (
					<div css={tableScrollCss}>
						<Table aria-label="Stuck patterns">
							<thead>
								<tr>
									<th scope="col">Category</th>
									<th scope="col">Stuck on</th>
									<th scope="col" css={numberCellCss}>
										Sessions
									</th>
									<th scope="col" css={numberCellCss}>
										Organizations
									</th>
									<th scope="col" css={numberCellCss}>
										Share of category
									</th>
									<th scope="col">Fix</th>
								</tr>
							</thead>
							<tbody>
								{data.patterns.map((pattern) => (
									<tr
										key={`${pattern.categoryId}|${pattern.stuckKind}|${pattern.stuckTool}`}
									>
										<th scope="row" css={{ fontWeight: 'inherit' }}>
											{pattern.categoryName}
										</th>
										<td>
											{sessionStuckKindLabels[pattern.stuckKind]} (
											{pattern.stuckTool})
										</td>
										<td css={numberCellCss}>
											{pattern.sessions.toLocaleString()}
										</td>
										<td css={numberCellCss}>{pattern.orgs.toLocaleString()}</td>
										<td css={numberCellCss}>
											{Math.round(pattern.share * 100)}%
										</td>
										<td>
											{pattern.fixedOn ? (
												<span>
													Marked fixed {pattern.fixedOn}:{' '}
													{percent(pattern.before)} before,{' '}
													{percent(pattern.after)} after
												</span>
											) : (
												<Button
													type="button"
													variant="secondary"
													size="sm"
													disabled={busy}
													onClick={() =>
														markFixed.mutate({
															data: {
																categoryId: pattern.categoryId,
																stuckKind: pattern.stuckKind,
																stuckTool: pattern.stuckTool,
															},
														})
													}
												>
													Mark fixed
												</Button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</Table>
					</div>
				)}
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Success by client"
				description="Clients over the minimum."
			>
				{data.clients.length === 0 ? (
					<p css={mutedCss}>No client is over the minimum yet.</p>
				) : (
					<div css={tableScrollCss}>
						<Table aria-label="Sessions by client">
							<thead>
								<tr>
									<th scope="col">Client</th>
									<th scope="col" css={numberCellCss}>
										Sessions
									</th>
									<th scope="col" css={numberCellCss}>
										Ended without errors
									</th>
									<th scope="col" css={numberCellCss}>
										Ended stuck
									</th>
								</tr>
							</thead>
							<tbody>
								{data.clients.map((row) => (
									<tr key={row.clientName}>
										<th scope="row" css={{ fontWeight: 'inherit' }}>
											{row.clientName}
										</th>
										<td css={numberCellCss}>{row.sessions.toLocaleString()}</td>
										<td css={numberCellCss}>
											{share(row.endedWithoutErrors, row.sessions)}
										</td>
										<td css={numberCellCss}>
											{share(row.stuck, row.sessions)}
										</td>
									</tr>
								))}
							</tbody>
						</Table>
					</div>
				)}
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Category name checks"
				description="Whether categorization is working. Each new name gets a format check, then a second model that sees only the name and says whether it holds user data. Up to three attempts."
			>
				<MetadataGrid
					items={[
						{
							label: 'Sessions labeled',
							value: labelChecks.labeled.toLocaleString(),
						},
						{
							label: 'Reused a category',
							value: labelChecks.reused.toLocaleString(),
						},
						{
							label: 'Names proposed',
							value: labelChecks.proposals.toLocaleString(),
						},
						{
							label: 'Names accepted',
							value: labelChecks.accepted.toLocaleString(),
						},
						{
							label: 'Rejected by format check',
							value: labelChecks.rejectedPrecheck.toLocaleString(),
						},
						{
							label: 'Rejected by second model',
							value: labelChecks.rejectedJudge.toLocaleString(),
						},
						{
							label: 'Rejection rate',
							value: percent(labelChecks.rejectionRate),
						},
						{
							label: 'Failed all three attempts',
							value: `${labelChecks.failedThreeAttempts.toLocaleString()} (${percent(labelChecks.threeAttemptFailureRate)})`,
						},
						{
							label: 'Model errors',
							value: labelChecks.modelFailed.toLocaleString(),
						},
					]}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Categories"
				description="Names the model proposed and both checks accepted. Retire one to remove the name and every count stored under it."
			>
				{data.categories.length === 0 ? (
					<p css={mutedCss}>No categories yet.</p>
				) : (
					<div css={tableScrollCss}>
						<Table aria-label="Categories">
							<thead>
								<tr>
									<th scope="col">Name</th>
									<th scope="col">Status</th>
									<th scope="col" css={numberCellCss}>
										Sessions
									</th>
									<th scope="col">
										<span css={{ position: 'absolute', left: '-9999px' }}>
											Retire
										</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{data.categories.map((category) => (
									<tr key={category.id}>
										<th scope="row" css={{ fontWeight: 'inherit' }}>
											{category.name}
										</th>
										<td>{category.status}</td>
										<td css={numberCellCss}>
											{category.sessions === null
												? 'Under minimum'
												: category.sessions.toLocaleString()}
										</td>
										<td css={{ textAlign: 'end', paddingBlock: spacing.xs }}>
											{category.status === 'active' ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													disabled={busy}
													onClick={() =>
														retire.mutate({ data: { categoryId: category.id } })
													}
												>
													Retire
												</Button>
											) : null}
										</td>
									</tr>
								))}
							</tbody>
						</Table>
					</div>
				)}
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}
