/** @jsxImportSource @emotion/react */
import {
	formatDurationMs,
	logLevelColor,
	runAttributionSubtitle,
	runDisplayName,
	statusColor,
	statusLabel,
	surfaceLabel,
	triageLabel,
} from './account-activity-shared.ts'
import { renderInlineWorkflowNameSubtitle } from './workflow-name-display.tsx'
import {
	accountManagementNarrowMq,
	AccountManagementMessage,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import { renderHighlightedCode } from '../components/syntax-highlight.tsx'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { type AccountActivityRunDetail } from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
} from '#universal/styles/style-primitives.ts'

export function renderActivityRunDetail(detail: AccountActivityRunDetail) {
	const attribution = runAttributionSubtitle(detail)
	return (
		<section
			css={{
				...recordBodyCss,
				overflowWrap: 'anywhere',
				'& > *': { minWidth: 0 },
			}}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>{runDisplayName(detail)}</h2>
				{renderInlineWorkflowNameSubtitle({
					displayedName: runDisplayName(detail),
					idempotencyKey: detail.idempotencyKey,
				})}
				{attribution ? <p css={descriptionCss}>{attribution}</p> : null}
				<p css={descriptionCss}>
					{surfaceLabel(detail.surface)} run with{' '}
					{detail.logCount === 1
						? '1 captured log line'
						: `${detail.logCount} captured log lines`}
					.
				</p>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Status',
						value: (
							<span css={{ color: statusColor(detail.status) }}>
								{statusLabel(detail.status)}
							</span>
						),
					},
					{
						label: 'Triage',
						value: triageLabel(detail),
					},
					{
						label: 'Triage note',
						value: detail.triageNote ?? '—',
					},
					{
						label: 'Triaged at',
						value: <TimestampValue value={detail.triagedAt} />,
					},
					{
						label: 'Triaged by',
						value: detail.triagedBy ?? '—',
					},
					{
						label: 'Surface',
						value: surfaceLabel(detail.surface),
					},
					{
						label: 'Entry',
						value: detail.entry ?? '—',
					},
					{
						label: 'Worker id',
						value: detail.workerId ? (
							<IdValue value={detail.workerId} label="worker id" />
						) : (
							'—'
						),
					},
					{
						label: 'Started',
						value: <TimestampValue value={detail.startedAt} />,
					},
					{
						label: 'Finished',
						value: <TimestampValue value={detail.finishedAt} />,
					},
					{
						label: 'Duration',
						value: formatDurationMs(detail.durationMs),
					},
					{
						label: 'Package id',
						value: detail.packageId ? (
							<IdValue value={detail.packageId} label="package id" />
						) : (
							'—'
						),
					},
					{
						label: 'Job id',
						value: detail.jobId ? (
							<IdValue value={detail.jobId} label="job id" />
						) : (
							'—'
						),
					},
					{
						label: 'Workflow id',
						value: detail.workflowId ? (
							<IdValue value={detail.workflowId} label="workflow id" />
						) : (
							'—'
						),
					},
					{
						label: 'Storage id',
						value: detail.storageId ? (
							<IdValue value={detail.storageId} label="storage id" />
						) : (
							'—'
						),
					},
					{
						label: 'Source id',
						value: detail.sourceId ? (
							<IdValue value={detail.sourceId} label="source id" />
						) : (
							'—'
						),
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
						label: 'Run id',
						value: <IdValue value={detail.id} label="run id" />,
					},
				]}
			/>

			{detail.errorMessage ? (
				<AccountManagementMessage tone="error">
					{detail.errorName
						? `${detail.errorName}: ${detail.errorMessage}`
						: detail.errorMessage}
				</AccountManagementMessage>
			) : null}

			<div css={fieldCss}>
				<span css={fieldLabelCss}>Logs</span>
				{detail.logs.length === 0 ? (
					<p css={{ margin: 0, color: colors.textMuted }}>
						No log lines were captured for this run.
					</p>
				) : (
					<pre
						css={{
							margin: 0,
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.background,
							color: colors.text,
							fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
							fontSize: typography.fontSize.sm,
							overflowX: 'auto',
							whiteSpace: 'pre-wrap',
							overflowWrap: 'anywhere',
							display: 'grid',
							gap: spacing.xs,
						}}
					>
						{detail.logs.map((entry) => (
							<span
								key={`${entry.sequence}-${entry.level}`}
								css={{
									display: 'grid',
									gridTemplateColumns: '4.5rem minmax(0, 1fr)',
									gap: spacing.sm,
									color: logLevelColor(entry.level),
									[accountManagementNarrowMq]: {
										gridTemplateColumns: 'minmax(0, 1fr)',
										gap: spacing.xs,
									},
								}}
							>
								<span
									css={{
										color: colors.textMuted,
										textTransform: 'uppercase',
										fontSize: typography.fontSize.xs,
										lineHeight: '1.5rem',
									}}
								>
									{entry.level}
								</span>
								<span>{entry.message}</span>
							</span>
						))}
					</pre>
				)}
			</div>

			{Object.keys(detail.metadata).length > 0 ? (
				<div css={fieldCss}>
					<span css={fieldLabelCss}>Metadata</span>
					<div
						css={{
							minWidth: 0,
							'& pre': {
								margin: 0,
								padding: spacing.sm,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
								fontSize: typography.fontSize.sm,
								overflowX: 'auto',
								whiteSpace: 'pre-wrap',
								overflowWrap: 'anywhere',
							},
						}}
					>
						{renderHighlightedCode(
							detail.metadataHighlighted ??
								plainHighlightedCode(
									JSON.stringify(detail.metadata, null, 2),
									'json',
								),
						)}
					</div>
				</div>
			) : null}
		</section>
	)
}
