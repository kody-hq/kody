/** @jsxImportSource @emotion/react */
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { deleteOrganizationSessionInsights } from '#start/server/org-settings-mutations'
import type { OrgSessionInsightsLoaderData } from '#universal/loader-data.ts'
import { orgSessionInsightsPath } from '#universal/org-pages.ts'
import {
	sessionOutcomeLabels,
	sessionStuckKindLabels,
	type SessionInsightsEntry,
	type SessionInsightsScope,
	type SessionInsightsView,
} from '#universal/session-analytics.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { Button } from '../components/button.tsx'
import { Dialog, DialogActions } from '../components/dialog.tsx'
import { renderIcon } from '../components/icon.tsx'
import { Table } from '../components/table.tsx'
import { Tab, TabList, TabPanel, Tabs } from '../components/tabs.tsx'
import { TextLink } from '../components/text-link.tsx'
import { orgSettingsMutationOptions } from '../org-settings-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
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
const stackCss = { display: 'grid', gap: spacing.lg, minWidth: 0 }

function percent(part: number, whole: number) {
	return whole > 0 ? `${Math.round((part / whole) * 100)}%` : 'None yet'
}

function entryKey(entry: SessionInsightsEntry) {
	return [
		entry.categoryId,
		entry.outcome,
		entry.stuckKind ?? '',
		entry.stuckTool ?? '',
	].join('|')
}

type DeleteTarget =
	| { kind: 'entry'; entry: SessionInsightsEntry }
	| { kind: 'all' }

function ScopeInsights({
	scope,
	view,
	orgName,
	disabled,
	onDelete,
}: {
	scope: SessionInsightsScope
	view: SessionInsightsView
	orgName: string
	disabled: boolean
	onDelete: (target: DeleteTarget) => void
}) {
	const { summary } = view
	const subject =
		scope === 'mine' ? 'your agent sessions' : `everyone in ${orgName}`
	if (summary.sessions === 0) {
		return (
			<p css={mutedCss} data-testid={`session-insights-empty-${scope}`}>
				Nothing has been counted for {subject} in the last {view.windowDays}{' '}
				days.
			</p>
		)
	}
	return (
		<div css={stackCss} data-testid={`session-insights-${scope}`}>
			<AccountManagementPanel
				title={`Last ${view.windowDays} days`}
				description={`Counts for ${subject}. Kody never stores what agents send, so there is no list of sessions.`}
				actions={
					<Button
						type="button"
						variant="danger"
						size="sm"
						disabled={disabled}
						data-testid={`session-insights-delete-all-${scope}`}
						onClick={() => onDelete({ kind: 'all' })}
					>
						Delete all
					</Button>
				}
			>
				<MetadataGrid
					items={[
						{ label: 'Sessions', value: summary.sessions.toLocaleString() },
						{
							label: 'Ended without errors',
							value: percent(summary.endedWithoutErrors, summary.sessions),
						},
						{
							label: 'Recovered after errors',
							value: percent(summary.recovered, summary.sessions),
						},
						{
							label: 'Ended stuck',
							value: percent(summary.stuck, summary.sessions),
						},
						{
							label: 'Sessions that got a hint',
							value: summary.nudgedSessions.toLocaleString(),
						},
						{
							label: 'Calls with an error',
							value: percent(summary.errors, summary.calls),
						},
					]}
				/>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="By kind of work"
				description="Each row is a general category, how those sessions ended, and where they got stuck. Delete any row; rows cannot be edited."
			>
				<div css={tableScrollCss}>
					<Table aria-label={`Session insights for ${subject}`}>
						<thead>
							<tr>
								<th scope="col">Category</th>
								<th scope="col">How it ended</th>
								<th scope="col">Stuck on</th>
								<th scope="col" css={numberCellCss}>
									Sessions
								</th>
								<th scope="col" css={numberCellCss}>
									Calls
								</th>
								<th scope="col" css={numberCellCss}>
									Errors
								</th>
								<th scope="col">
									<span css={{ position: 'absolute', left: '-9999px' }}>
										Delete
									</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{view.entries.map((entry) => (
								<tr key={entryKey(entry)} data-testid="session-insights-entry">
									<th scope="row" css={{ fontWeight: 'inherit' }}>
										{entry.categoryName}
									</th>
									<td>{sessionOutcomeLabels[entry.outcome]}</td>
									<td>
										{entry.stuckKind
											? `${sessionStuckKindLabels[entry.stuckKind]}${entry.stuckTool ? ` (${entry.stuckTool})` : ''}`
											: ''}
									</td>
									<td css={numberCellCss}>{entry.sessions.toLocaleString()}</td>
									<td css={numberCellCss}>{entry.calls.toLocaleString()}</td>
									<td css={numberCellCss}>{entry.errors.toLocaleString()}</td>
									<td css={{ textAlign: 'end' }}>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={disabled}
											aria-label={`Delete ${entry.categoryName}, ${sessionOutcomeLabels[entry.outcome]}`}
											data-testid="session-insights-delete-entry"
											onClick={() => onDelete({ kind: 'entry', entry })}
										>
											{renderIcon('close', { size: '1rem' })}
											Delete
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</Table>
				</div>
			</AccountManagementPanel>
			<AccountManagementPanel
				title="By client"
				description="Which agent apps the sessions came from."
			>
				<div css={tableScrollCss}>
					<Table aria-label={`Sessions by client for ${subject}`}>
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
							{view.clients.map((client) => (
								<tr key={client.clientName}>
									<th scope="row" css={{ fontWeight: 'inherit' }}>
										{client.clientName}
									</th>
									<td css={numberCellCss}>
										{client.sessions.toLocaleString()}
									</td>
									<td css={numberCellCss}>
										{percent(client.endedWithoutErrors, client.sessions)}
									</td>
									<td css={numberCellCss}>
										{percent(client.stuck, client.sessions)}
									</td>
								</tr>
							))}
						</tbody>
					</Table>
				</div>
			</AccountManagementPanel>
		</div>
	)
}

export function SessionInsightsPage({
	data,
	queryKey,
}: {
	data: OrgSessionInsightsLoaderData
	queryKey: QueryKey
}) {
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [scope, setScope] = useState<SessionInsightsScope>('mine')
	const [target, setTarget] = useState<DeleteTarget | null>(null)
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const mutation = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			deleteOrganizationSessionInsights,
		),
	)
	const href = orgSessionInsightsPath(data.org.slug)
	const settingsHref = `/@${data.org.slug}/-/settings`
	const orgName = data.org.displayName
	const whose = scope === 'mine' ? 'your own data' : `all of ${orgName}`

	function confirmDelete() {
		if (!target || mutation.isPending) return
		const isCurrent = capture()
		setMessage(null)
		mutation.mutate(
			{
				orgSlug: data.org.slug,
				scope,
				...(target.kind === 'entry'
					? {
							entry: {
								categoryId: target.entry.categoryId,
								outcome: target.entry.outcome,
								stuckKind: target.entry.stuckKind,
								stuckTool: target.entry.stuckTool,
							},
						}
					: {}),
			},
			{
				onSuccess: () => {
					if (!isCurrent()) return
					setTarget(null)
					setMessage({ tone: 'info', text: 'Deleted.' })
				},
				onError: (error) => {
					if (!isCurrent()) return
					setTarget(null)
					setMessage({ tone: 'error', text: error.message })
				},
			},
		)
	}

	return (
		<AccountManagementShell layout="detail" currentHref={href}>
			<AccountPageHeader
				title="Session insights"
				description="How agent sessions go: the same numbers Kody staff see, limited to your own data. You can delete entries, never edit them."
				currentHref={href}
			/>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			{data.state !== 'enabled' ? (
				<AccountManagementPanel
					title="Session analytics is off"
					testId="session-insights-off"
				>
					<p css={mutedCss}>
						Nothing is being counted for {orgName}. An Owner or Admin can turn
						session analytics on in{' '}
						<TextLink tone="prose" href={settingsHref}>
							Organization settings
						</TextLink>
						.
					</p>
				</AccountManagementPanel>
			) : data.organization ? (
				<Tabs
					activeTab={scope}
					onActiveTabChange={(next) => {
						setMessage(null)
						setScope(next === 'org' ? 'org' : 'mine')
					}}
				>
					<TabList aria-label="Whose sessions">
						<Tab name="mine">Mine</Tab>
						<Tab name="org">Everyone in {orgName}</Tab>
					</TabList>
					<TabPanel name="mine">
						<ScopeInsights
							scope="mine"
							view={data.mine}
							orgName={orgName}
							disabled={mutation.isPending}
							onDelete={setTarget}
						/>
					</TabPanel>
					<TabPanel name="org">
						<ScopeInsights
							scope="org"
							view={data.organization}
							orgName={orgName}
							disabled={mutation.isPending}
							onDelete={setTarget}
						/>
					</TabPanel>
				</Tabs>
			) : (
				<ScopeInsights
					scope="mine"
					view={data.mine}
					orgName={orgName}
					disabled={mutation.isPending}
					onDelete={setTarget}
				/>
			)}
			<Dialog
				open={target !== null}
				onClose={() => {
					if (!mutation.isPending) setTarget(null)
				}}
				role="alertdialog"
				title={
					target?.kind === 'entry'
						? 'Delete this entry?'
						: 'Delete all session insights?'
				}
				description={
					target?.kind === 'entry'
						? `This deletes the "${target.entry.categoryName}" (${sessionOutcomeLabels[target.entry.outcome]}) counts for ${whose}. They also leave the combined totals Kody staff and package publishers see. This cannot be undone.`
						: `This deletes every session insights count for ${whose}. They also leave the combined totals Kody staff and package publishers see. This cannot be undone.`
				}
			>
				<DialogActions>
					<Button
						type="button"
						variant="secondary"
						disabled={mutation.isPending}
						onClick={() => setTarget(null)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="danger"
						disabled={mutation.isPending}
						data-testid="session-insights-confirm-delete"
						onClick={confirmDelete}
					>
						{mutation.isPending ? 'Deleting…' : 'Delete'}
					</Button>
				</DialogActions>
			</Dialog>
		</AccountManagementShell>
	)
}
