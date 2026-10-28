/** @jsxImportSource @emotion/react */
import { formatTimestamp } from '../components/local-timestamp.tsx'
import { AccountManagementPanel } from './account-management-components.tsx'
import { recordStampCss } from './record-table.tsx'
import type { AccountToggleChange } from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

const sourceLabels: Record<string, string> = {
	web: 'the web app',
	mcp: 'MCP',
	api: 'the API',
	cli: 'the CLI',
	'package-app': 'a package app',
	enablement: 'its enablement',
	scheduler: 'the scheduler',
	offboarding: 'member removal',
	automation: 'an automation',
}

function toggleChangeSubject(change: AccountToggleChange) {
	const name = change.name ?? change.resourceId
	if (change.resource === 'job') return { name, kind: 'Job' }
	const kind =
		change.triggerKind === 'cron'
			? 'Job enablement'
			: change.triggerKind === 'webhook'
				? 'Webhook enablement'
				: change.triggerKind === 'subscription'
					? 'Subscription enablement'
					: 'Enablement'
	return { name, kind }
}

function toggleChangeLabel(change: AccountToggleChange) {
	if (change.to === 'on') return 'Turned on'
	if (change.to === 'off') return 'Turned off'
	return 'Paused'
}

function toggleChangeActor(change: AccountToggleChange) {
	const who =
		change.actorKind === 'automation'
			? 'Kody (automatic)'
			: change.actorUsername
				? `@${change.actorUsername}`
				: 'A person'
	const prefix = change.actorKind === 'admin' ? 'Site admin ' : ''
	const via = sourceLabels[change.source] ?? change.source
	return `${prefix}${who} via ${via}`
}

export function AccountActivityToggleChanges({
	changes,
}: {
	changes: Array<AccountToggleChange>
}) {
	return (
		<AccountManagementPanel
			title="On/off changes"
			description="Who turned a job or an enablement on or off in the last 7 days, from where, and why. Only Owners see this."
			ariaLabel="On/off changes"
		>
			{changes.length === 0 ? (
				<p
					css={{
						margin: 0,
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
					}}
				>
					No jobs or enablements were turned on or off in the last 7 days.
				</p>
			) : (
				<ul
					css={{
						listStyle: 'none',
						margin: 0,
						padding: 0,
						display: 'grid',
						gap: spacing.xs,
					}}
				>
					{changes.map((change) => {
						const subject = toggleChangeSubject(change)
						const turnedOn = change.to === 'on'
						return (
							<li
								key={change.id}
								css={{
									display: 'grid',
									gap: '0.25rem',
									padding: `${spacing.sm} ${spacing.md}`,
									border: `1px solid ${colors.border}`,
									borderRadius: radius.md,
									backgroundColor: colors.surface,
								}}
							>
								<span
									css={{
										display: 'flex',
										flexWrap: 'wrap',
										alignItems: 'baseline',
										gap: spacing.sm,
										minWidth: 0,
									}}
								>
									<strong
										css={{
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
											overflowWrap: 'anywhere',
										}}
									>
										{subject.name}
									</strong>
									<span
										css={{
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										}}
									>
										{subject.kind}
									</span>
									<span
										css={{
											fontSize: typography.fontSize.sm,
											fontWeight: typography.fontWeight.semibold,
											color: turnedOn ? colors.primary : colors.warningText,
										}}
									>
										{toggleChangeLabel(change)}
									</span>
									<span css={[recordStampCss, { marginLeft: 'auto' }]}>
										{formatTimestamp(change.createdAt)}
									</span>
								</span>
								<span
									css={{
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									}}
								>
									{toggleChangeActor(change)}
									{change.reason ? `: ${change.reason}` : null}
								</span>
							</li>
						)
					})}
				</ul>
			)}
		</AccountManagementPanel>
	)
}
