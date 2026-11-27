/** @jsxImportSource @emotion/react */
import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { sessionStuckKindLabels } from '#universal/session-analytics.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { packageSessionInsightsQuery } from '../package-session-insights-query.ts'
import {
	AccountManagementPanel,
	MetadataGrid,
} from './account-management-components.tsx'

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

/**
 * How a public package does in agent sessions in other organizations that
 * turned on session analytics. Combined totals only.
 */
export function PackageSessionInsights({
	username,
	kodyId,
}: {
	username: string
	kodyId: string
}) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const read = useQuery({
		...packageSessionInsightsQuery(actorKey, { username, kodyId }),
		retry: false,
		retryOnMount: false,
	})
	const insights = read.data
	if (!insights) return null
	return (
		<AccountManagementPanel
			title="Agent sessions"
			description={`How this package does in agent sessions in organizations that turned on session analytics, over the last ${insights.windowDays} days. Combined totals only: no organization, person, or session is identified.`}
			testId="package-session-insights"
		>
			{insights.available ? (
				<MetadataGrid
					items={[
						{ label: 'Sessions', value: insights.sessions.toLocaleString() },
						{ label: 'Organizations', value: insights.orgs.toLocaleString() },
						{
							label: 'Ended without errors',
							value: `${Math.round((insights.endedWithoutErrors / insights.sessions) * 100)}%`,
						},
						...insights.stuckKinds.map((kind) => ({
							key: `stuck:${kind.stuckKind}`,
							label: `Stuck: ${sessionStuckKindLabels[kind.stuckKind]}`,
							value: `${kind.sessions.toLocaleString()} sessions`,
						})),
					]}
				/>
			) : (
				<p css={mutedCss}>
					Numbers appear once this package has at least {insights.minSessions}{' '}
					sessions from at least {insights.minOrgs} organizations.
				</p>
			)}
		</AccountManagementPanel>
	)
}
