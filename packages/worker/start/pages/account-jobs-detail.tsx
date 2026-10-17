/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { formatTimestamp } from '#client/format-timestamp.ts'
import {
	AccountManagementMessage,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import { renderHighlightedCode } from '../components/syntax-highlight.tsx'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { type AccountJobDetail } from '#universal/loader-data.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	type PostAccountJobsAction,
	formatDurationMs,
	statusColor,
	statusLabel,
} from './account-jobs-shared.ts'
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
function packageValue(
	username: string,
	job: Pick<AccountJobDetail, 'packageName' | 'packageKodyId'>,
) {
	if (username && job.packageKodyId && job.packageName) {
		return (
			<SiteLink
				href={routes.communityPackage.href({
					username,
					kodyId: job.packageKodyId,
				})}
				css={primaryLinkCss}
			>
				{job.packageName}
			</SiteLink>
		)
	}
	return job.packageName ?? 'Package'
}
export function renderJobDetailPlaceholder(title: string, body: string) {
	return (
		<div css={{ ...recordBodyCss, gap: spacing.sm }}>
			<h2
				css={{
					margin: 0,
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				}}
			>
				{title}
			</h2>
			<p css={{ margin: 0, color: colors.textMuted }}>{body}</p>
		</div>
	)
}
export function renderAccountJobDetail(input: {
	username: string
	currentHref: string
	detail: AccountJobDetail
	isMutating: boolean
	runJobAction: PostAccountJobsAction<{ id: string }>
	setKillSwitchAction: PostAccountJobsAction<{
		id: string
		killSwitchEnabled: boolean
	}>
	navigateToList: () => void
}) {
	const {
		username,
		detail,
		isMutating,
		runJobAction,
		setKillSwitchAction,
		navigateToList,
	} = input
	return (
		<section css={recordBodyCss}>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>{detail.name}</h2>
				<p css={descriptionCss}>
					Package-owned job. Schedule and name are owned by package publish;
					kill switch and run-now are available here. Use the kill switch to
					stop it.
				</p>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Package',
						value: packageValue(username, detail),
					},
					{
						label: 'Expires',
						value: detail.expiresAt ? (
							<>
								{detail.expired ? 'Expired ' : ''}
								<TimestampValue value={detail.expiresAt} />
							</>
						) : (
							'Never'
						),
					},
					{
						label: 'Status',
						value: (
							<span css={{ color: statusColor(detail) }}>
								{statusLabel(detail)}
							</span>
						),
					},
					{
						label: 'Schedule',
						value: detail.scheduleSummary,
					},
					{
						label: 'Timezone',
						value: detail.timezone,
					},
					{
						label: 'Next run',
						value: <TimestampValue value={detail.nextRunAt} />,
					},
					{
						label: 'Last run',
						value: <TimestampValue value={detail.lastRunAt} />,
					},
					{
						label: 'Last duration',
						value: formatDurationMs(detail.lastDurationMs),
					},
					{
						label: 'Runs',
						value: `${detail.runCount} total · ${detail.successCount} ok · ${detail.errorCount} error`,
					},
					{
						label: 'Storage id',
						value: <IdValue value={detail.storageId} label="storage id" />,
					},
					{
						label: 'Source id',
						value: <IdValue value={detail.sourceId} label="source id" />,
					},
					{
						label: 'Published commit',
						value: detail.publishedCommit ? (
							<IdValue
								value={detail.publishedCommit}
								label="published commit"
							/>
						) : (
							'—'
						),
					},
					{
						label: 'Updated',
						value: <TimestampValue value={detail.updatedAt} />,
					},
				]}
			/>

			{detail.lastRunError ? (
				<AccountManagementMessage tone="error">
					{detail.lastRunError}
				</AccountManagementMessage>
			) : null}

			<p css={descriptionCss}>
				To change this job&apos;s schedule or name, update the package job
				declaration and publish the package again.
			</p>

			<div css={fieldCss}>
				<span css={fieldLabelCss}>Recent runs</span>
				{detail.recentRuns.length === 0 ? (
					<p css={{ margin: 0, color: colors.textMuted }}>
						No runs recorded yet.
					</p>
				) : (
					<div
						css={{
							overflowX: 'auto',
							border: `1px solid ${colors.border}`,
							borderRadius: radius.md,
						}}
					>
						<table
							css={{
								width: '100%',
								borderCollapse: 'collapse',
								fontSize: typography.fontSize.sm,
							}}
						>
							<thead>
								<tr>
									{[
										'Started',
										'Finished',
										'Status',
										'Duration',
										'Error',
										'',
									].map((heading) => (
										<th
											key={heading || 'logs'}
											css={{
												textAlign: 'left',
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
												color: colors.textMuted,
												fontWeight: typography.fontWeight.medium,
											}}
										>
											{heading}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{detail.recentRuns.map((run) => (
									<tr key={run.id}>
										<td
											css={{
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											}}
										>
											{formatTimestamp(run.startedAt)}
										</td>
										<td
											css={{
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											}}
										>
											{formatTimestamp(run.finishedAt)}
										</td>
										<td
											css={{
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
												color:
													run.status === 'error'
														? colors.error
														: run.status === 'running'
															? colors.textMuted
															: colors.primary,
											}}
										>
											{run.status}
										</td>
										<td
											css={{
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											}}
										>
											{formatDurationMs(run.durationMs)}
										</td>
										<td
											css={{
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
												color: colors.textMuted,
												maxWidth: '16rem',
												overflowWrap: 'anywhere',
											}}
										>
											{run.error ?? '—'}
										</td>
										<td
											css={{
												padding: spacing.sm,
												borderBottom: `1px solid ${colors.border}`,
											}}
										>
											<SiteLink
												href={relocateAccountHref(
													`/account/activity/${encodeURIComponent(run.id)}`,
													input.currentHref,
												)}
												css={primaryLinkCss}
											>
												Logs
											</SiteLink>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{detail.params ? (
				<div css={fieldCss}>
					<span css={fieldLabelCss}>Params</span>
					<div
						css={{
							'& pre': {
								margin: 0,
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								fontFamily: 'monospace',
								fontSize: typography.fontSize.sm,
								overflowX: 'auto',
								whiteSpace: 'pre-wrap',
							},
						}}
					>
						{renderHighlightedCode(
							detail.paramsHighlighted ??
								plainHighlightedCode(
									JSON.stringify(detail.params, null, 2),
									'json',
								),
						)}
					</div>
				</div>
			) : null}

			<div
				css={{
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
				}}
			>
				<button
					type="button"
					disabled={isMutating}
					onClick={() =>
						runJobAction({
							id: detail.id,
							successMessage: (payload) => {
								if (payload.runNow?.deletedAfterRun) {
									return payload.runNow.ok
										? 'Ran one-off job and deleted it.'
										: `Ran one-off job (failed) and deleted it${
												payload.runNow.error ? `: ${payload.runNow.error}` : '.'
											}`
								}
								if (payload.runNow && !payload.runNow.ok) {
									return `Run finished with an error${payload.runNow.error ? `: ${payload.runNow.error}` : '.'}`
								}
								return 'Job run requested.'
							},
							failureMessage: 'Unable to run job now.',
							afterSuccess: (payload) => {
								if (payload.runNow?.deletedAfterRun) {
									navigateToList()
								}
							},
						})
					}
					css={primaryButtonCss}
				>
					Run now
				</button>
				<button
					type="button"
					disabled={isMutating}
					onClick={() =>
						setKillSwitchAction({
							id: detail.id,
							killSwitchEnabled: !detail.killSwitchEnabled,
							successMessage: () =>
								detail.killSwitchEnabled
									? 'Cleared kill switch.'
									: 'Enabled kill switch.',
							failureMessage: 'Unable to update kill switch.',
						})
					}
					css={secondaryButtonCss}
				>
					{detail.killSwitchEnabled
						? 'Clear kill switch'
						: 'Enable kill switch'}
				</button>
			</div>
		</section>
	)
}
