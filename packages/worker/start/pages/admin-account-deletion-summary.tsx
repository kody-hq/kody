/** @jsxImportSource @emotion/react */
import { formatMicroUsd } from '#universal/credits.ts'
import {
	describeAdminAccountDeletionAcknowledgement,
	type AdminAccountDeletionSummary,
} from '#universal/admin-account-deletion.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import {
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'

const countLabels = [
	['packages', 'Packages'],
	['jobs', 'Jobs'],
	['credentials', 'Credentials'],
	['connections', 'Connections'],
	['sessions', 'Sessions'],
	['orgMemberships', 'Org memberships'],
	['memories', 'Memories'],
	['webhooks', 'Webhooks'],
	['usage', 'Usage'],
] as const

export function AdminAccountDeletionSummaryList(props: {
	summary: AdminAccountDeletionSummary
}) {
	const { summary } = props
	return (
		<div
			data-testid="admin-account-deletion-summary"
			css={{ display: 'grid', gap: spacing.md }}
		>
			<MetadataGrid
				items={[
					{ label: 'Handle', value: `@${summary.handle}` },
					{ label: 'Email', value: summary.email },
					{
						label: 'Created',
						value: <TimestampValue value={summary.createdAt} />,
					},
					{ label: 'Plan', value: summary.plan },
					...countLabels.map(([key, label]) => ({
						label,
						value: summary.counts[key].toLocaleString('en-US'),
					})),
					{
						label: 'Credit balance',
						value: formatMicroUsd(summary.creditBalanceMicroUsd),
					},
				]}
			/>
			{summary.acknowledgementReasons.length > 0 ? (
				<div
					css={getAccentCalloutCss({ accentColor: colors.danger })}
					data-testid="admin-account-deletion-acknowledgement"
				>
					<p css={{ margin: 0, fontWeight: typography.fontWeight.semibold }}>
						Approve only after acknowledging:
					</p>
					<ul
						css={{
							margin: 0,
							paddingLeft: spacing.lg,
							display: 'grid',
							gap: spacing.xs,
						}}
					>
						{summary.acknowledgementReasons.map((reason) => (
							<li key={reason}>
								{describeAdminAccountDeletionAcknowledgement(summary, reason)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{summary.deletionBlocked ? (
				<p role="alert" css={{ margin: 0, color: colors.danger }}>
					{summary.deletionBlocked}
				</p>
			) : null}
		</div>
	)
}
