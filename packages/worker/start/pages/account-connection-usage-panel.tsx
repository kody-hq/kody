/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import {
	AccountManagementPanel,
	TimestampValue,
} from './account-management-components.tsx'
import { accountConnectionsUsageHref } from '#universal/account-connections.ts'
import {
	connectionUsageWindowKeys,
	type AccountConnectionUsageLoaderData,
	type ConnectionUsageCaller,
	type ConnectionUsageCountKey,
	type ConnectionUsageTotals,
	type ConnectionUsageWindow,
} from '#universal/connection-usage.ts'
import {
	connectionUsageCountKeys,
	connectionUsageCountNoun,
	connectionUsageEntryLabel,
	connectionUsageHasActivity,
	connectionUsageKindLabel,
	connectionUsageOtherCounts,
	connectionUsageWindowLabels,
	formatConnectionUsageCount,
	formatConnectionUsageQuantity,
} from '#universal/connection-usage-presentation.ts'
import { type ConnectedMcpAgent } from '#universal/connected-mcp-agents.ts'
import {
	descriptionCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
type Agents = Array<ConnectedMcpAgent>
const summaryRowLimit = 6
export type ConnectionUsageState =
	| {
			kind: 'loading'
	  }
	| {
			kind: 'error'
			message: string
	  }
	| {
			kind: 'ready'
			usage: AccountConnectionUsageLoaderData
	  }
type UsageRow = {
	id: string
	name: string
	detail: string
	href: string | null
	totals: ConnectionUsageTotals
}
function formatDay(day: string, withYear: boolean) {
	const date = new Date(`${day}T00:00:00.000Z`)
	if (Number.isNaN(date.getTime())) return day
	return date.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		...(withYear ? { year: 'numeric' } : {}),
		timeZone: 'UTC',
	})
}
/** Years appear only when the window spans New Year: `Dec 29, 2026 – Jan 4, 2027`. */
function formatWindow(window: ConnectionUsageWindow) {
	const withYear = window.startDay.slice(0, 4) !== window.endDay.slice(0, 4)
	return window.startDay === window.endDay
		? formatDay(window.startDay, false)
		: `${formatDay(window.startDay, withYear)} – ${formatDay(window.endDay, withYear)}`
}
function capWeekTotal(row: UsageRow, capCountKey: ConnectionUsageCountKey) {
	return row.totals.capWeek[capCountKey]
}
function usageRows(input: {
	usage: AccountConnectionUsageLoaderData
	agents: Agents
	pathname: string
}): Array<UsageRow> {
	const { usage } = input
	const rows: Array<UsageRow> = usage.connections.map((entry) => ({
		id: entry.id,
		name: connectionUsageEntryLabel(entry, input.agents),
		detail: connectionUsageKindLabel(entry.credentialKind),
		href: accountConnectionsUsageHref(input.pathname, entry.id),
		totals: entry.totals,
	}))
	for (const automation of usage.automations ?? []) {
		rows.push({
			id: automation.id,
			name: automation.label,
			detail: 'Automation',
			href: accountConnectionsUsageHref(input.pathname, automation.id),
			totals: automation.totals,
		})
	}
	for (const [index, person] of (usage.people ?? []).entries()) {
		rows.push({
			id: personRowId(person.username, index),
			name: person.username ? `@${person.username}` : 'Former member',
			detail: 'Teammate',
			href: null,
			totals: person.totals,
		})
	}
	return rows
		.filter((row) => connectionUsageHasActivity(row.totals))
		.sort(
			(a, b) =>
				capWeekTotal(b, usage.capCountKey) - capWeekTotal(a, usage.capCountKey),
		)
}
function UsageTable(props: {
	caption: string
	rowHeader: string
	rows: Array<UsageRow>
	capCountKey: ConnectionUsageCountKey
	testId: string
}) {
	const { capCountKey } = props
	return (
		<div css={tableScrollCss}>
			<table data-testid={props.testId} css={tableCss}>
				<caption css={captionCss}>{props.caption}</caption>
				<thead>
					<tr>
						<th scope="col">{props.rowHeader}</th>
						{connectionUsageWindowKeys.map((key) => (
							<th key={key} scope="col" css={numericCss}>
								{connectionUsageWindowLabels[key]}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{props.rows.map((row) => (
						<tr key={row.id} data-connection-usage-row={row.id}>
							<th scope="row">
								<span css={rowHeaderCss}>
									{row.href ? (
										<SiteLink href={row.href} css={primaryLinkCss}>
											{row.name}
										</SiteLink>
									) : (
										<span>{row.name}</span>
									)}
									<span css={rowDetailCss}>{rowDetail(row, capCountKey)}</span>
								</span>
							</th>
							{connectionUsageWindowKeys.map((key) => (
								<td
									key={key}
									css={numericCss}
									data-connection-usage-window={key}
								>
									{formatConnectionUsageCount(row.totals[key][capCountKey])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
function rowDetail(row: UsageRow, capCountKey: ConnectionUsageCountKey) {
	const other = connectionUsageOtherCounts(row.totals, capCountKey)
	return other ? `${row.detail} · 7 days: ${other}` : row.detail
}
function RawCountsTable(props: {
	caption: string
	totals: ConnectionUsageTotals
}) {
	return (
		<div css={tableScrollCss}>
			<table data-testid="connection-usage-raw-counts" css={tableCss}>
				<caption css={captionCss}>{props.caption}</caption>
				<thead>
					<tr>
						<th scope="col">Count</th>
						{connectionUsageWindowKeys.map((key) => (
							<th key={key} scope="col" css={numericCss}>
								{connectionUsageWindowLabels[key]}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{connectionUsageCountKeys.map((countKey) => (
						<tr key={countKey} data-connection-usage-count={countKey}>
							<th scope="row" css={rawCountHeaderCss}>
								{capitalize(connectionUsageCountNoun(countKey))}
							</th>
							{connectionUsageWindowKeys.map((key) => (
								<td key={key} css={numericCss}>
									{formatConnectionUsageCount(props.totals[key][countKey])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
function capitalize(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1)
}
function capUnitSentence(usage: AccountConnectionUsageLoaderData) {
	return `Counts are ${connectionUsageCountNoun(usage.capCountKey)}, the unit the hosted execute cap counts.`
}
function renderUpdated(usage: AccountConnectionUsageLoaderData) {
	return (
		<p css={updatedCss} data-testid="connection-usage-updated">
			{usage.updatedAt ? (
				<>
					Updated <TimestampValue value={usage.updatedAt} />. Usage refreshes
					hourly and is kept {usage.retentionDays} days.
				</>
			) : (
				`Usage refreshes hourly and is kept ${usage.retentionDays} days.`
			)}
		</p>
	)
}
function renderState(state: ConnectionUsageState, ready: () => ReactNode) {
	switch (state.kind) {
		case 'loading':
			return <p css={descriptionCss}>Loading usage…</p>
		case 'error':
			return (
				<p role="alert" css={descriptionCss}>
					{state.message}
				</p>
			)
		case 'ready':
			return ready()
		default: {
			const exhaustive: never = state
			return exhaustive
		}
	}
}
/** Connections list: who used the cap this week, heaviest first. */
export function ConnectionUsageSummaryPanel(props: {
	state: ConnectionUsageState
	agents: Agents
	pathname: string
}) {
	const { state } = props
	return (
		<AccountManagementPanel
			title="Usage by connection"
			description="Which agents, CLI logins, API tokens, and automations ran code here, so you can see what is using your execute cap."
			ariaLabel="Usage by connection"
		>
			<div data-testid="connection-usage-summary" css={stackCss}>
				{renderState(state, () => {
					if (state.kind !== 'ready') return null
					const rows = usageRows({
						usage: state.usage,
						agents: props.agents,
						pathname: props.pathname,
					})
					return (
						<>
							{rows.length === 0 ? (
								<p css={descriptionCss}>
									No usage through these connections in the last 7 days.
								</p>
							) : (
								<UsageTable
									caption={capUnitSentence(state.usage)}
									rowHeader="Connection"
									rows={rows.slice(0, summaryRowLimit)}
									capCountKey={state.usage.capCountKey}
									testId="connection-usage-summary-table"
								/>
							)}
							{renderUpdated(state.usage)}
						</>
					)
				})}
				<p css={{ margin: 0 }}>
					<SiteLink
						href={accountConnectionsUsageHref(props.pathname)}
						data-testid="connection-usage-details-link"
						css={primaryLinkCss}
					>
						View usage details
					</SiteLink>
				</p>
			</div>
		</AccountManagementPanel>
	)
}
/** `/connections/usage`: per-connection totals and what called through each. */
export function ConnectionUsageDetails(props: {
	state: ConnectionUsageState
	agents: Agents
	pathname: string
	/** `ConnectionUsageEntry.id` from `?connection=`. */
	focus: string | null
}) {
	const { state } = props
	if (state.kind !== 'ready') {
		return (
			<AccountManagementPanel
				title="Connection usage"
				ariaLabel="Connection usage"
			>
				{renderState(state, () => null)}
			</AccountManagementPanel>
		)
	}
	const { usage } = state
	const focus = props.focus
	const connections = usage.connections.filter(
		(entry) => !focus || entry.id === focus,
	)
	const automations = (usage.automations ?? []).filter(
		(entry) => !focus || entry.id === focus,
	)
	const focusMissing =
		focus !== null && connections.length === 0 && automations.length === 0
	const windowsText = connectionUsageWindowKeys
		.map(
			(key) =>
				`${connectionUsageWindowLabels[key]}: ${formatWindow(usage.windows[key])} (UTC)`,
		)
		.join(' · ')
	return (
		<>
			<AccountManagementPanel
				title="Connection usage"
				description={`${capUnitSentence(usage)} ${windowsText}.`}
				ariaLabel="Connection usage"
			>
				<div css={stackCss}>
					{renderUpdated(usage)}
					{focus ? (
						<p css={{ margin: 0 }}>
							<SiteLink
								href={accountConnectionsUsageHref(props.pathname)}
								data-testid="connection-usage-show-all"
								css={primaryLinkCss}
							>
								Show all connections
							</SiteLink>
						</p>
					) : null}
					{focusMissing ? (
						<p css={descriptionCss}>
							No usage for that connection in the last 7 days.
						</p>
					) : null}
					{usage.automations === null ? (
						<p css={descriptionCss} data-testid="connection-usage-own-only">
							You see usage for your own connections. Owners and billing admins
							also see automations and teammates.
						</p>
					) : null}
				</div>
			</AccountManagementPanel>
			{connections.length === 0 && !focus ? (
				<AccountManagementPanel
					title="Your connections"
					ariaLabel="Your connections"
				>
					<p css={descriptionCss}>
						No usage through your connections in the last 7 days.
					</p>
				</AccountManagementPanel>
			) : null}
			{connections.map((entry) => {
				const name = connectionUsageEntryLabel(entry, props.agents)
				return (
					<AccountManagementPanel
						key={entry.id}
						title={name}
						description={connectionUsageKindLabel(entry.credentialKind)}
						ariaLabel={`${name} usage`}
					>
						<div
							data-testid="connection-usage-entry"
							data-connection-usage-entry={entry.id}
							css={stackCss}
						>
							<RawCountsTable
								caption={`${name}: all counts`}
								totals={entry.totals}
							/>
							{renderCallersTable({
								name,
								callers: entry.callers,
								capCountKey: usage.capCountKey,
							})}
						</div>
					</AccountManagementPanel>
				)
			})}
			{usage.automations !== null && (!focus || automations.length > 0) ? (
				<AccountManagementPanel
					title="Automations"
					description="Scheduled jobs, webhooks, inbound email, and event subscriptions run without a connection."
					ariaLabel="Automations"
				>
					{automations.length === 0 ? (
						<p css={descriptionCss}>No automation usage in the last 7 days.</p>
					) : (
						<UsageTable
							caption={`Automation usage, in ${connectionUsageCountNoun(usage.capCountKey)}`}
							rowHeader="Automation"
							rows={automations.map((automation) => ({
								id: automation.id,
								name: automation.label,
								detail: connectionUsageAutomationDetail(automation.callers),
								href: automation.href,
								totals: automation.totals,
							}))}
							capCountKey={usage.capCountKey}
							testId="connection-usage-automations"
						/>
					)}
					{focus
						? automations.map((automation) => (
								<div
									key={automation.id}
									data-testid="connection-usage-automation-entry"
									css={stackCss}
								>
									<RawCountsTable
										caption={`${automation.label}: all counts`}
										totals={automation.totals}
									/>
									{renderCallersTable({
										name: automation.label,
										callers: automation.callers,
										capCountKey: usage.capCountKey,
									})}
								</div>
							))
						: null}
				</AccountManagementPanel>
			) : null}
			{usage.people !== null && !focus ? (
				<AccountManagementPanel
					title="Teammates"
					description="Usage by other people in this organization, through their own connections."
					ariaLabel="Teammates"
				>
					{usage.people.length === 0 ? (
						<p css={descriptionCss}>No teammate usage in the last 7 days.</p>
					) : (
						<UsageTable
							caption={`Teammate usage, in ${connectionUsageCountNoun(usage.capCountKey)}`}
							rowHeader="Person"
							rows={usage.people.map((person, index) => ({
								id: personRowId(person.username, index),
								name: person.username ? `@${person.username}` : 'Former member',
								detail: 'Teammate',
								href: null,
								totals: person.totals,
							}))}
							capCountKey={usage.capCountKey}
							testId="connection-usage-people"
						/>
					)}
				</AccountManagementPanel>
			) : null}
			{usage.unattributed &&
			!focus &&
			connectionUsageHasActivity(usage.unattributed) ? (
				<p css={descriptionCss} data-testid="connection-usage-unattributed">
					{`${unattributedQuantity(usage.unattributed, usage.capCountKey)} in the last 7 days were recorded before connection tracking started and are not tied to a connection.`}
				</p>
			) : null}
		</>
	)
}
function personRowId(username: string | null, index: number) {
	return username ? `person:${username}` : `person:former:${index}`
}
/** The cap unit, plus any other counts so runs-only history does not read as zero. */
function unattributedQuantity(
	totals: ConnectionUsageTotals,
	capCountKey: ConnectionUsageCountKey,
) {
	const cap = totals.last7Days[capCountKey]
	const other = connectionUsageOtherCounts(totals, capCountKey)
	if (cap > 0 || !other) {
		return formatConnectionUsageQuantity(capCountKey, cap)
	}
	return other
}
function renderCallersTable(input: {
	name: string
	callers: ReadonlyArray<ConnectionUsageCaller>
	capCountKey: ConnectionUsageCountKey
}) {
	return (
		<UsageTable
			caption={`What ran through ${input.name}, in ${connectionUsageCountNoun(input.capCountKey)}`}
			rowHeader="Package"
			rows={input.callers.map((caller) => ({
				id: caller.packageId || 'adhoc',
				name: caller.label,
				detail: caller.packageId ? 'Package' : 'Ad hoc execute',
				href: caller.href,
				totals: caller.totals,
			}))}
			capCountKey={input.capCountKey}
			testId="connection-usage-callers"
		/>
	)
}
function connectionUsageAutomationDetail(
	callers: ReadonlyArray<{
		packageId: string
		label: string
	}>,
) {
	const packages = callers
		.filter((caller) => caller.packageId)
		.map((caller) => caller.label)
	return packages.length > 0 ? `Runs ${packages.join(', ')}` : 'Automation'
}
const updatedCss: CSSObject = {
	...descriptionCss,
	fontSize: typography.fontSize.sm,
}
const stackCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
}
const tableScrollCss: CSSObject = {
	display: 'block',
	minWidth: 0,
	maxWidth: '100%',
	overflowX: 'auto' as const,
}
const tableCss: CSSObject = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	'& th, & td': {
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
		textAlign: 'start' as const,
		verticalAlign: 'top' as const,
	},
	'& thead th': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.semibold,
		whiteSpace: 'nowrap' as const,
	},
}
const captionCss: CSSObject = {
	captionSide: 'top' as const,
	textAlign: 'start' as const,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	paddingBottom: spacing.xs,
}
const numericCss: CSSObject = {
	textAlign: 'end' as const,
	fontVariantNumeric: 'tabular-nums' as const,
	whiteSpace: 'nowrap' as const,
}
const rowHeaderCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	fontWeight: typography.fontWeight.medium,
	minWidth: '10rem',
}
const rawCountHeaderCss: CSSObject = {
	fontWeight: typography.fontWeight.medium,
	whiteSpace: 'nowrap' as const,
}
const rowDetailCss: CSSObject = {
	color: colors.textMuted,
	fontWeight: typography.fontWeight.normal,
	fontSize: typography.fontSize.xs,
}
